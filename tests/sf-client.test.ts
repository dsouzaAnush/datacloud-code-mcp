import { describe, expect, test } from "vitest";
import pino from "pino";
import { buildSalesforceClient } from "../src/sandbox/sf-client.js";
import type { AppConfig } from "../src/config.js";

const logger = pino({ enabled: false });

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataCloudApiBaseUrl: "https://example.c360a.salesforce.com",
    dataCloudAcceptHeader: "application/json",
    allowWrites: false,
    requestTimeoutMs: 5000,
    maxRetries: 0,
    readCacheTtlMs: 5000,
    executeMaxBodyBytes: 48000,
    executeBodyPreviewChars: 6000,
    ...overrides
  } as AppConfig;
}

describe("buildSalesforceClient", () => {
  test("blocks writes when allowWrites is false", async () => {
    const { request } = buildSalesforceClient({
      config: makeConfig(),
      logger,
      authContext: { accessToken: "token", instanceUrl: "https://example.c360a.salesforce.com" },
      userId: "u1"
    });

    await expect(
      request({ method: "POST", path: "/test" })
    ).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  });

  test("allows reads with authentication", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });

    const { request } = buildSalesforceClient({
      config: makeConfig(),
      logger,
      authContext: { accessToken: "token", instanceUrl: "https://example.c360a.salesforce.com" },
      userId: "u1",
      fetchFn: mockFetch
    });

    const result = await request({ method: "GET", path: "/api/v1/metadata/" });
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
  });

  test("serves repeated reads from cache", async () => {
    let calls = 0;
    const mockFetch: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const { request } = buildSalesforceClient({
      config: makeConfig({ readCacheTtlMs: 60000 }),
      logger,
      authContext: { accessToken: "token", instanceUrl: "https://example.c360a.salesforce.com" },
      userId: "u1",
      fetchFn: mockFetch
    });

    await request({ method: "GET", path: "/api/v1/metadata/" });
    const second = await request({ method: "GET", path: "/api/v1/metadata/" });

    expect(calls).toBe(1);
    expect(second.warnings).toContain("served_from_read_cache");
  });

  test("exposes resolved baseUrl", () => {
    const { baseUrl } = buildSalesforceClient({
      config: makeConfig(),
      logger,
      authContext: { accessToken: "token", instanceUrl: "https://custom.my.salesforce.com" },
      userId: "u1"
    });

    expect(baseUrl).toBe("https://custom.my.salesforce.com");
  });

  test("throws on non-2xx response", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" }
      });

    const { request } = buildSalesforceClient({
      config: makeConfig(),
      logger,
      authContext: { accessToken: "token", instanceUrl: "https://example.c360a.salesforce.com" },
      userId: "u1",
      fetchFn: mockFetch
    });

    await expect(request({ method: "GET", path: "/test" })).rejects.toMatchObject({
      code: "SALESFORCE_API_ERROR",
      status: 403
    });
  });

  test("allows writes when allowWrites is true", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ id: "123" }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });

    const { request } = buildSalesforceClient({
      config: makeConfig({ allowWrites: true }),
      logger,
      authContext: { accessToken: "token", instanceUrl: "https://example.c360a.salesforce.com" },
      userId: "u1",
      fetchFn: mockFetch
    });

    const result = await request({ method: "POST", path: "/test", body: { name: "test" } });
    expect(result.success).toBe(true);
    expect(result.status).toBe(201);
  });
});
