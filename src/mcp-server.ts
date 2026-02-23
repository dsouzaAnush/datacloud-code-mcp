import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import type { DataCloudOAuthService } from "./auth/oauth-service.js";
import type { DataCloudSchemaService } from "./schema/datacloud-schema-service.js";
import type { SearchIndex } from "./search/search-index.js";
import { DataCloudExecutor, ToolError } from "./execute/datacloud-executor.js";
import { getHeaderValue } from "./utils/headers.js";
import type { ExecuteRequest } from "./types.js";

interface ServerDeps {
  config: AppConfig;
  schemaService: DataCloudSchemaService;
  searchIndex: SearchIndex;
  oauthService: DataCloudOAuthService;
  executor: DataCloudExecutor;
}

function serializeResult<T extends object>(data: T) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ],
    structuredContent: data as { [key: string]: unknown }
  };
}

function resolveUserId(headerCarrier: unknown, userIdHeader: string): string {
  return (
    getHeaderValue(headerCarrier, userIdHeader) ??
    getHeaderValue(headerCarrier, "x-user-id") ??
    "default"
  );
}

function formatError(error: unknown): string {
  if (error instanceof ToolError) {
    return JSON.stringify(
      {
        code: error.code,
        message: error.message,
        status: error.status
      },
      null,
      2
    );
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function createDataCloudMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    {
      name: "datacloud-code-mode-mcp",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.registerTool(
    "search",
    {
      title: "Search Data Cloud API Operations",
      description:
        "Searches Salesforce Data Cloud (Data360) operations derived from OpenAPI schema and docs context.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(25).optional(),
        resource_filter: z.array(z.string()).optional()
      }
    },
    async ({ query, limit, resource_filter }) => {
      await deps.schemaService.ensureReady();
      const results = deps.searchIndex.search({
        query,
        limit,
        resourceFilter: resource_filter
      });
      return serializeResult(results);
    }
  );

  server.registerTool(
    "execute",
    {
      title: "Execute Data Cloud Operation",
      description: "Validates and executes Data Cloud API calls by operation_id.",
      inputSchema: {
        operation_id: z.string().min(1),
        path_params: z.record(z.string(), z.string()).optional(),
        query_params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
        body: z.unknown().optional(),
        dry_run: z.boolean().optional(),
        confirm_write_token: z.string().optional()
      }
    },
    async (args, extra) => {
      try {
        await deps.schemaService.ensureReady();
        const userId = resolveUserId(extra.requestInfo?.headers, deps.config.userIdHeader);
        const result = await deps.executor.execute(args as ExecuteRequest, userId);
        return serializeResult(result);
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: formatError(error)
            }
          ]
        };
      }
    }
  );

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
      return serializeResult(status);
    }
  );

  return server;
}
