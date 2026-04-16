import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import type { AuthService } from "./auth/auth-modes.js";
import type { DataCloudSchemaService } from "./schema/datacloud-schema-service.js";
import { getHeaderValue } from "./utils/headers.js";
import { runUserCode } from "./sandbox/runner.js";
import { buildSalesforceClient } from "./sandbox/sf-client.js";
import { truncateResponse } from "./sandbox/truncate.js";

interface ServerDeps {
  config: AppConfig;
  logger: Logger;
  schemaService: DataCloudSchemaService;
  oauthService: AuthService;
}

function resolveUserId(headerCarrier: unknown, userIdHeader: string): string {
  return getHeaderValue(headerCarrier, userIdHeader) ?? "default";
}

function text(value: unknown, maxBytes: number): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: truncateResponse(value, maxBytes) }]
  };
}

function errorResult(message: string): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    isError: true,
    content: [{ type: "text", text: message }]
  };
}

export function createDataCloudMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    {
      name: "datacloud-code-mode-mcp",
      version: "0.2.0"
    },
    {
      capabilities: { tools: {} }
    }
  );

  const tags = () => deps.schemaService.getTags();
  const maxOut = deps.config.sandboxMaxOutputBytes;

  // ── search ────────────────────────────────────────────────────────────
  server.registerTool(
    "search",
    {
      title: "Search Data Cloud API",
      description: buildSearchDescription(tags),
      inputSchema: {
        code: z.string().describe("JavaScript async arrow function to search the OpenAPI spec")
      }
    },
    async ({ code }) => {
      try {
        await deps.schemaService.ensureReady();
        const spec = deps.schemaService.getResolvedSpec();
        const result = await runUserCode(code, { spec }, { timeoutMs: deps.config.sandboxTimeoutMs });
        if (result.err) return errorResult(`Search error: ${result.err}`);
        return text(result.result, maxOut);
      } catch (error) {
        deps.logger.warn({ err: error }, "search tool error");
        return errorResult(`Search error: ${(error as Error).message}`);
      }
    }
  );

  // ── execute ───────────────────────────────────────────────────────────
  server.registerTool(
    "execute",
    {
      title: "Execute Data Cloud API code",
      description: buildExecuteDescription(),
      inputSchema: {
        code: z.string().describe("JavaScript async arrow function to execute")
      }
    },
    async ({ code }, extra) => {
      try {
        await deps.schemaService.ensureReady();
        const userId = resolveUserId(extra.requestInfo?.headers, deps.config.userIdHeader);
        const authContext = await deps.oauthService.getAuthContext(userId);
        if (!authContext) {
          return errorResult(
            "Not authenticated. Complete OAuth at /oauth/start?user_id=default first, or set CDP_ACCESS_TOKEN + CDP_INSTANCE_URL."
          );
        }

        const client = buildSalesforceClient({
          config: deps.config,
          logger: deps.logger,
          authContext,
          userId
        });

        const instanceUrl = client.baseUrl;

        // Wrap salesforce.request so its return value is serialized/parsed,
        // preventing host-realm prototype chain access from sandbox code.
        const safeRequest = async (options: unknown) => {
          const res = await client.request(options as Parameters<typeof client.request>[0]);
          return JSON.parse(JSON.stringify(res));
        };

        const result = await runUserCode(
          code,
          { salesforce: { request: safeRequest }, instanceUrl },
          { timeoutMs: deps.config.sandboxTimeoutMs }
        );
        if (result.err) return errorResult(`Execute error: ${result.err}`);
        return text(result.result, maxOut);
      } catch (error) {
        deps.logger.warn({ err: error }, "execute tool error");
        return errorResult(`Execute error: ${(error as Error).message}`);
      }
    }
  );

  // ── auth_status ───────────────────────────────────────────────────────
  server.registerTool(
    "auth_status",
    {
      title: "Check OAuth Status",
      description: "Returns Data Cloud OAuth authentication status for the current caller.",
      inputSchema: {}
    },
    async (_args, extra) => {
      const userId = resolveUserId(extra.requestInfo?.headers, deps.config.userIdHeader);
      const status = await deps.oauthService.getAuthStatus(userId);
      return text(status, maxOut);
    }
  );

  return server;
}

// ── tool description builders ─────────────────────────────────────────

function buildSearchDescription(getTags: () => string[]): string {
  return `Search the Salesforce Data Cloud (Data 360) OpenAPI spec. All $refs are pre-resolved inline.

Available in your code:
${SPEC_TYPES}

Tags: ${getTags().slice(0, 30).join(", ")}

Examples:
// Find all endpoints by tag
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.tags?.some(t => t.toLowerCase().includes('segment'))) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary });
      }
    }
  }
  return results;
}

// Inspect a specific endpoint schema
async () => {
  const op = spec.paths['/services/data/v64.0/ssot/query-sql']?.post;
  return { summary: op?.summary, requestBody: op?.requestBody, responses: op?.responses };
}`;
}

function buildExecuteDescription(): string {
  return `Execute JavaScript code against the Salesforce Data Cloud API. First use 'search' to find the right endpoints, then write code using salesforce.request().

Available in your code:
${SALESFORCE_TYPES}

Your code must be an async arrow function that returns the result.

Examples:
// List data streams
async () => {
  return await salesforce.request({
    method: "GET",
    path: "/services/data/v64.0/ssot/data-streams"
  });
}

// Execute SQL query
async () => {
  const result = await salesforce.request({
    method: "POST",
    path: "/services/data/v64.0/ssot/query-sql",
    body: { sql: "SELECT FirstName__c, LastName__c FROM UnifiedIndividual__dlm LIMIT 10" }
  });
  return result;
}

// Chain calls: list segments then get first one
async () => {
  const list = await salesforce.request({ method: "GET", path: "/services/data/v64.0/ssot/segments" });
  const segments = list.body?.data || [];
  if (segments.length === 0) return { message: "No segments found" };
  const first = await salesforce.request({
    method: "GET",
    path: \"/services/data/v64.0/ssot/segments/\" + segments[0].id
  });
  return first;
}`;
}

const SPEC_TYPES = `interface OperationInfo {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown;
  requestBody?: unknown;
  responses?: unknown;
}
interface PathItem { get?: OperationInfo; post?: OperationInfo; put?: OperationInfo; patch?: OperationInfo; delete?: OperationInfo; }
declare const spec: { paths: Record<string, PathItem> };`;

const SALESFORCE_TYPES = `interface SalesforceRequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;
  rawBody?: boolean;
}
interface SalesforceResponse { success: boolean; status: number; headers: Record<string, string>; body: unknown; request_id?: string; warnings?: string[]; }
declare const salesforce: { request(options: SalesforceRequestOptions): Promise<SalesforceResponse>; };
declare const instanceUrl: string;`;
