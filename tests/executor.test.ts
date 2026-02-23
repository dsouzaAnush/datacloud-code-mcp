import { describe, expect, test } from "vitest";
import pino from "pino";
import { DataCloudExecutor, ToolError } from "../src/execute/datacloud-executor.js";
import type { AppConfig } from "../src/config.js";
import type { JsonSchema, PlatformOperation } from "../src/types.js";

const baseConfig: AppConfig = {
  port: 3000,
  host: "0.0.0.0",
  logLevel: "silent",
  dataCloudOpenApiPath: "./fixtures/openapi.yaml",
  dataCloudDocsPath: "./fixtures/docs",
  dataCloudApiBaseUrl: "https://example.c360a.salesforce.com",
  dataCloudAcceptHeader: "application/json",
  schemaRefreshMs: 3600000,
  catalogCachePath: "./data/catalog-cache.test.json",
  allowWrites: false,
  requestTimeoutMs: 5000,
  maxRetries: 2,
  readCacheTtlMs: 5000,
  executeMaxBodyBytes: 48000,
  executeBodyPreviewChars: 6000,
  userIdHeader: "x-user-id",
  writeConfirmationSecret: "unit-test-secret",
  tokenStorePath: "./data/tokens.test.json",
  tokenEncryptionKeyBase64: Buffer.alloc(32, 1).toString("base64"),
  oauthClientId: undefined,
  oauthClientSecret: undefined,
  oauthScope: "api cdp_query_api refresh_token",
  oauthAuthorizeUrl: "https://login.salesforce.com/services/oauth2/authorize",
  oauthTokenUrl: "https://login.salesforce.com/services/oauth2/token",
  oauthRedirectUri: "http://localhost:3000/oauth/callback",
  dataCloudTokenExchangePath: "/services/a360/token"
};

function makeExecutor(options: {
  operation: PlatformOperation;
  rootSchema?: JsonSchema;
  allowWrites?: boolean;
  fetchFn?: typeof fetch;
  authContext?: { accessToken: string; instanceUrl?: string } | null;
  configOverrides?: Partial<AppConfig>;
}) {
  const config = {
    ...baseConfig,
    allowWrites: options.allowWrites ?? false,
    ...options.configOverrides
  };

  return new DataCloudExecutor({
    config,
    logger: pino({ enabled: false }),
    getOperation: (operationId) =>
      operationId === options.operation.operationId ? options.operation : undefined,
    getRootSchema: () => options.rootSchema,
    getAuthContext: async () =>
      options.authContext === undefined ? { accessToken: "access-token" } : options.authContext,
    fetchFn: options.fetchFn
  });
}

function makeOperation(input: Partial<PlatformOperation> = {}): PlatformOperation {
  return {
    operationId: input.operationId ?? "GET /api/v1/metadata/",
    method: input.method ?? "GET",
    pathTemplate: input.pathTemplate ?? "/api/v1/metadata/",
    rawHref: input.rawHref ?? "/api/v1/metadata/",
    source: input.source ?? "Data Cloud",
    pathParams: input.pathParams ?? [],
    queryParams: input.queryParams ?? [],
    requiredParams: input.requiredParams ?? [],
    isMutating: input.isMutating ?? false,
    searchText: input.searchText ?? "",
    title: input.title,
    description: input.description,
    rel: input.rel,
    requestSchema: input.requestSchema,
    targetSchemaRef: input.targetSchemaRef
  };
}

describe("DataCloudExecutor", () => {
  test("fails preflight when required path param is missing", async () => {
    const operation = makeOperation({
      operationId: "GET /services/data/v64.0/ssot/query-sql/{queryId}/rows",
      pathTemplate: "/services/data/v64.0/ssot/query-sql/{queryId}/rows",
      pathParams: [{ name: "queryId" }],
      requiredParams: ["queryId"]
    });

    const executor = makeExecutor({ operation, rootSchema: { definitions: {} } });

    await expect(executor.execute({ operation_id: operation.operationId }, "u1")).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
  });

  test("fails preflight when required query param is missing", async () => {
    const operation = makeOperation({
      operationId: "GET /api/v1/dataGraph/{dataGraphEntityName}",
      pathTemplate: "/api/v1/dataGraph/{dataGraphEntityName}",
      pathParams: [{ name: "dataGraphEntityName" }],
      queryParams: [{ name: "lookupKeys", required: true }],
      requiredParams: ["dataGraphEntityName", "query.lookupKeys"]
    });

    const executor = makeExecutor({ operation, rootSchema: { definitions: {} } });

    await expect(
      executor.execute(
        {
          operation_id: operation.operationId,
          path_params: { dataGraphEntityName: "Profile_dg" }
        },
        "u1"
      )
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("rejects invalid body against request schema", async () => {
    const operation = makeOperation({
      operationId: "POST /services/data/v64.0/ssot/query-sql",
      method: "POST",
      pathTemplate: "/services/data/v64.0/ssot/query-sql",
      isMutating: true,
      requiredParams: ["body.sql"],
      requestSchema: {
        type: ["object"],
        required: ["sql"],
        properties: {
          sql: { type: ["string"] }
        }
      }
    });

    const executor = makeExecutor({ operation, rootSchema: { definitions: {} } });

    await expect(
      executor.execute(
        {
          operation_id: operation.operationId,
          body: {}
        },
        "u1"
      )
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("returns dry_run confirm token for mutating operation", async () => {
    const operation = makeOperation({
      operationId: "POST /services/data/v64.0/ssot/segments",
      method: "POST",
      pathTemplate: "/services/data/v64.0/ssot/segments",
      isMutating: true
    });

    const executor = makeExecutor({ operation, rootSchema: { definitions: {} } });

    const result = await executor.execute(
      {
        operation_id: operation.operationId,
        dry_run: true,
        body: { name: "VIP" }
      },
      "u1"
    );

    expect(result.status).toBe(0);
    expect(result.body).toMatchObject({ dry_run: true });
    expect((result.body as Record<string, unknown>).confirm_write_token).toBeTruthy();
  });

  test("retries idempotent read calls", async () => {
    const operation = makeOperation();

    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ message: "retry" }), {
          status: 500,
          headers: {
            "content-type": "application/json"
          }
        });
      }
      return new Response(JSON.stringify({ metadata: [] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-123"
        }
      });
    };

    const executor = makeExecutor({
      operation,
      rootSchema: { definitions: {} },
      fetchFn,
      authContext: { accessToken: "token", instanceUrl: "https://example.c360a.salesforce.com" }
    });

    const result = await executor.execute({ operation_id: operation.operationId }, "u1");

    expect(calls).toBe(2);
    expect(result.status).toBe(200);
    expect(result.request_id).toBe("req-123");
  });

  test("serves repeated read requests from short TTL cache", async () => {
    const operation = makeOperation();

    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ metadata: [] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-cache"
        }
      });
    };

    const executor = makeExecutor({
      operation,
      rootSchema: { definitions: {} },
      fetchFn,
      authContext: { accessToken: "token", instanceUrl: "https://example.c360a.salesforce.com" },
      configOverrides: { readCacheTtlMs: 60_000 }
    });

    await executor.execute({ operation_id: operation.operationId }, "u1");
    const second = await executor.execute({ operation_id: operation.operationId }, "u1");

    expect(calls).toBe(1);
    expect(second.warnings).toContain("served_from_read_cache");
  });

  test("blocks writes when ALLOW_WRITES is false", async () => {
    const operation = makeOperation({
      operationId: "POST /services/data/v64.0/ssot/segments",
      method: "POST",
      pathTemplate: "/services/data/v64.0/ssot/segments",
      isMutating: true
    });

    const executor = makeExecutor({ operation, rootSchema: { definitions: {} } });

    await expect(
      executor.execute(
        {
          operation_id: operation.operationId,
          confirm_write_token: "anything"
        },
        "u1"
      )
    ).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  });

  test("returns auth error when token is missing", async () => {
    const operation = makeOperation();

    const executor = makeExecutor({
      operation,
      rootSchema: { definitions: {} },
      authContext: null
    });

    await expect(executor.execute({ operation_id: operation.operationId }, "u1")).rejects.toMatchObject({
      code: "AUTH_REQUIRED"
    });
  });

  test("throws provider-specific error on non-2xx", async () => {
    const operation = makeOperation();

    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: {
          "content-type": "application/json"
        }
      });

    const executor = makeExecutor({
      operation,
      rootSchema: { definitions: {} },
      fetchFn
    });

    await expect(executor.execute({ operation_id: operation.operationId }, "u1")).rejects.toBeInstanceOf(
      ToolError
    );
    await expect(executor.execute({ operation_id: operation.operationId }, "u1")).rejects.toMatchObject({
      code: "DATACLOUD_API_ERROR",
      status: 403
    });
  });
});
