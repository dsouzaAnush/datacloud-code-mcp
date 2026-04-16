import { describe, expect, test } from "vitest";
import pino from "pino";
import { resolveAuthService, type AuthService } from "../src/auth/auth-modes.js";
import type { AppConfig } from "../src/config.js";
import type { DataCloudOAuthService } from "../src/auth/oauth-service.js";

const logger = pino({ enabled: false });

function mockOAuth(): DataCloudOAuthService {
  return {
    getAuthContext: async () => ({ accessToken: "oauth-token", instanceUrl: "https://oauth.example.com" }),
    getAuthStatus: async () => ({ authenticated: true, scopes: ["api"], instance_url: "https://oauth.example.com" }),
    purgeExpiredState: () => {}
  } as unknown as DataCloudOAuthService;
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    cdpAuthFlow: "auto" as const,
    cdpLoginUrl: "https://login.salesforce.com",
    cdpClientId: undefined,
    cdpClientSecret: undefined,
    cdpUsername: undefined,
    cdpPassword: undefined,
    cdpAccessToken: undefined,
    cdpInstanceUrl: undefined,
    ...overrides
  } as AppConfig;
}

describe("resolveAuthService", () => {
  test("direct mode returns DirectTokenStrategy", async () => {
    const service = resolveAuthService(
      baseConfig({ cdpAuthFlow: "access_token" as const, cdpAccessToken: "my-token", cdpInstanceUrl: "https://dc.example.com" }),
      mockOAuth(),
      logger
    );
    const ctx = await service.getAuthContext("u1");
    expect(ctx).toEqual({ accessToken: "my-token", instanceUrl: "https://dc.example.com" });
  });

  test("auto mode prefers direct token over OAuth", async () => {
    const service = resolveAuthService(
      baseConfig({ cdpAccessToken: "direct-token", cdpInstanceUrl: "https://dc.example.com" }),
      mockOAuth(),
      logger
    );
    const ctx = await service.getAuthContext("u1");
    expect(ctx?.accessToken).toBe("direct-token");
  });

  test("auto mode falls back to OAuth when no other credentials", async () => {
    const service = resolveAuthService(baseConfig(), mockOAuth(), logger);
    const ctx = await service.getAuthContext("u1");
    expect(ctx?.accessToken).toBe("oauth-token");
  });

  test("oauth mode returns oauthService directly", async () => {
    const oauth = mockOAuth();
    const service = resolveAuthService(baseConfig({ cdpAuthFlow: "oauth" }), oauth, logger);
    expect(service).toBe(oauth);
  });

  test("getAuthStatus returns authenticated=false when no credentials", async () => {
    const noAuth = {
      ...mockOAuth(),
      getAuthContext: async () => null,
      getAuthStatus: async () => ({ authenticated: false, scopes: [] as string[] })
    } as unknown as DataCloudOAuthService;
    const service = resolveAuthService(baseConfig(), noAuth, logger);
    const status = await service.getAuthStatus("u1");
    expect(status.authenticated).toBe(false);
  });
});
