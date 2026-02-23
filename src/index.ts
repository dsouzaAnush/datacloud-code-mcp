import { randomUUID } from "node:crypto";
import pinoHttpImport from "pino-http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { EncryptedTokenStore } from "./auth/token-store.js";
import { DataCloudOAuthService } from "./auth/oauth-service.js";
import { DataCloudSchemaService } from "./schema/datacloud-schema-service.js";
import { SearchIndex } from "./search/search-index.js";
import { DataCloudExecutor } from "./execute/datacloud-executor.js";
import { createDataCloudMcpServer } from "./mcp-server.js";

interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

function isInitializeRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }

  const method = (body as { method?: unknown }).method;
  return method === "initialize";
}

async function main(): Promise<void> {
  const logger = createLogger(appConfig);
  const pinoHttp = pinoHttpImport as unknown as (options: { logger: typeof logger }) => (
    req: unknown,
    res: unknown,
    next: () => void
  ) => void;

  const encryptionKey =
    appConfig.tokenEncryptionKeyBase64 ?? Buffer.alloc(32, 1).toString("base64");

  if (!appConfig.tokenEncryptionKeyBase64) {
    logger.warn(
      "TOKEN_ENCRYPTION_KEY_BASE64 is not set. Using a local fallback key; this is not safe for production."
    );
  }

  const tokenStore = new EncryptedTokenStore(appConfig.tokenStorePath, encryptionKey);
  const oauthService = new DataCloudOAuthService(appConfig, tokenStore, logger);
  const schemaService = new DataCloudSchemaService(appConfig, logger);
  const searchIndex = new SearchIndex();

  await schemaService.bootstrapFromCache();
  if (schemaService.getOperations().length > 0) {
    searchIndex.setOperations(schemaService.getOperations(), schemaService.getDocsContext());
  }

  const refreshCatalog = async (force: boolean) => {
    await schemaService.refresh(force);
    if (schemaService.getOperations().length > 0) {
      searchIndex.setOperations(schemaService.getOperations(), schemaService.getDocsContext());
    }
  };

  void refreshCatalog(schemaService.getOperations().length === 0).catch((error) => {
    logger.warn({ err: error }, "Initial catalog refresh failed");
  });

  setInterval(async () => {
    try {
      oauthService.purgeExpiredState();
      await refreshCatalog(false);
    } catch (error) {
      logger.warn({ err: error }, "Background refresh failed");
    }
  }, appConfig.schemaRefreshMs).unref();

  const executor = new DataCloudExecutor({
    config: appConfig,
    logger,
    getOperation: (operationId) => schemaService.getOperation(operationId),
    getRootSchema: () => schemaService.getRootSchema(),
    getAuthContext: async (userId) => oauthService.getAuthContext(userId)
  });

  const app = createMcpExpressApp({ host: appConfig.host });
  app.use(pinoHttp({ logger }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "datacloud-code-mode-mcp" });
  });

  app.get("/oauth/start", (req, res) => {
    try {
      const userId = String(req.query.user_id ?? "default");
      const mode = String(req.query.mode ?? "redirect");
      const url = oauthService.buildAuthorizationUrl(userId);

      if (mode === "json") {
        res.json({ authorization_url: url, user_id: userId });
        return;
      }

      res.redirect(url);
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  app.get("/oauth/callback", async (req, res) => {
    const code = req.query.code;
    const state = req.query.state;

    if (typeof code !== "string" || typeof state !== "string") {
      res.status(400).send("Missing OAuth callback parameters: code/state");
      return;
    }

    try {
      const result = await oauthService.handleOAuthCallback(code, state);
      res
        .status(200)
        .send(`OAuth authentication complete for user: ${result.userId}. You can return to your MCP client.`);
    } catch (error) {
      res.status(400).send(`OAuth callback failed: ${String(error)}`);
    }
  });

  app.get("/oauth/status", async (req, res) => {
    const userId = String(req.query.user_id ?? "default");
    const status = await oauthService.getAuthStatus(userId);
    res.json({ user_id: userId, ...status });
  });

  const sessions = new Map<string, SessionRecord>();

  const buildServer = () =>
    createDataCloudMcpServer({
      config: appConfig,
      schemaService,
      searchIndex,
      oauthService,
      executor
    });

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    try {
      if (typeof sessionId === "string") {
        const existing = sessions.get(sessionId);
        if (!existing) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Unknown MCP session. Initialize first."
            },
            id: null
          });
          return;
        }

        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Missing MCP session ID and request is not initialize"
          },
          id: null
        });
        return;
      }

      let server: McpServer | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          if (!server) {
            logger.error({ sessionId: id }, "Session initialized before MCP server assignment");
            return;
          }
          sessions.set(id, { transport, server });
          logger.info({ sessionId: id }, "MCP session initialized");
        }
      });
      server = buildServer();

      transport.onclose = async () => {
        const id = transport.sessionId;
        if (id) {
          sessions.delete(id);
        }
        if (server) {
          await server.close();
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ err: error }, "Error handling MCP POST");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error"
          },
          id: null
        });
      }
    }
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    if (typeof sessionId !== "string") {
      res.status(400).send("Missing mcp-session-id header");
      return;
    }

    const existing = sessions.get(sessionId);
    if (!existing) {
      res.status(400).send("Unknown MCP session");
      return;
    }

    await existing.transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    if (typeof sessionId !== "string") {
      res.status(400).send("Missing mcp-session-id header");
      return;
    }

    const existing = sessions.get(sessionId);
    if (!existing) {
      res.status(400).send("Unknown MCP session");
      return;
    }

    await existing.transport.handleRequest(req, res);
  });

  app.listen(appConfig.port, appConfig.host, () => {
    logger.info(
      {
        host: appConfig.host,
        port: appConfig.port,
        mcpEndpoint: `http://${appConfig.host}:${appConfig.port}/mcp`
      },
      "Data Cloud Code Mode MCP server started"
    );
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
