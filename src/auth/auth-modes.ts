import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { AuthContext, AuthStatusResponse } from "../types.js";
import type { DataCloudOAuthService } from "./oauth-service.js";

export interface AuthService {
  getAuthContext(userId: string): Promise<AuthContext | null>;
  getAuthStatus(userId: string): Promise<AuthStatusResponse>;
}

class DirectTokenStrategy implements AuthService {
  constructor(
    private readonly accessToken: string,
    private readonly instanceUrl: string | undefined
  ) {}

  async getAuthContext(): Promise<AuthContext | null> {
    return { accessToken: this.accessToken, instanceUrl: this.instanceUrl };
  }

  async getAuthStatus(): Promise<AuthStatusResponse> {
    return { authenticated: true, scopes: [], instance_url: this.instanceUrl };
  }
}

interface TokenResponse {
  access_token: string;
  instance_url?: string;
  expires_in?: number;
}

class OAuthTokenStrategy implements AuthService {
  private cachedToken?: { token: AuthContext; expiresAt: number };

  constructor(
    private readonly label: string,
    private readonly tokenUrl: string,
    private readonly buildPayload: () => URLSearchParams,
    private readonly logger: Logger,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async getAuthContext(): Promise<AuthContext | null> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.token;
    }
    try {
      return await this.fetchToken();
    } catch (error) {
      this.logger.error({ err: error }, `${this.label} auth failed`);
      return null;
    }
  }

  async getAuthStatus(): Promise<AuthStatusResponse> {
    const ctx = await this.getAuthContext();
    return { authenticated: ctx !== null, scopes: [], instance_url: ctx?.instanceUrl };
  }

  private async fetchToken(): Promise<AuthContext> {
    const response = await this.fetchFn(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: this.buildPayload().toString()
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${this.label} token fetch failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as TokenResponse;
    const token: AuthContext = { accessToken: data.access_token, instanceUrl: data.instance_url };
    const ttlMs = (data.expires_in ?? 3600) * 1000;
    this.cachedToken = { token, expiresAt: Date.now() + ttlMs - 60_000 };
    return token;
  }
}

class FallbackChain implements AuthService {
  constructor(private readonly strategies: AuthService[]) {}

  async getAuthContext(userId: string): Promise<AuthContext | null> {
    for (const s of this.strategies) {
      const ctx = await s.getAuthContext(userId);
      if (ctx) return ctx;
    }
    return null;
  }

  async getAuthStatus(userId: string): Promise<AuthStatusResponse> {
    for (const s of this.strategies) {
      const status = await s.getAuthStatus(userId);
      if (status.authenticated) return status;
    }
    return { authenticated: false, scopes: [] };
  }
}

function createClientCredentialsStrategy(config: AppConfig, logger: Logger): OAuthTokenStrategy {
  return new OAuthTokenStrategy(
    "Client credentials",
    `${config.cdpLoginUrl}/services/oauth2/token`,
    () => new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.cdpClientId!,
      client_secret: config.cdpClientSecret!
    }),
    logger
  );
}

function createUsernamePasswordStrategy(config: AppConfig, logger: Logger): OAuthTokenStrategy {
  return new OAuthTokenStrategy(
    "Username/password",
    `${config.cdpLoginUrl}/services/oauth2/token`,
    () => new URLSearchParams({
      grant_type: "password",
      client_id: config.cdpClientId!,
      client_secret: config.cdpClientSecret!,
      username: config.cdpUsername!,
      password: config.cdpPassword!
    }),
    logger
  );
}

export function resolveAuthService(
  config: AppConfig,
  oauthService: DataCloudOAuthService,
  logger: Logger
): AuthService {
  const flow = config.cdpAuthFlow;

  if (flow === "access_token") {
    if (config.cdpAccessToken) {
      return new DirectTokenStrategy(config.cdpAccessToken, config.cdpInstanceUrl);
    }
    logger.warn("CDP_AUTH_FLOW=access_token but CDP_ACCESS_TOKEN is missing");
  }

  if (flow === "client_credentials") {
    if (config.cdpClientId && config.cdpClientSecret) {
      return createClientCredentialsStrategy(config, logger);
    }
    logger.warn("CDP_AUTH_FLOW=client_credentials but CDP_CLIENT_ID/SECRET are missing");
  }

  if (flow === "username_password") {
    if (config.cdpClientId && config.cdpClientSecret && config.cdpUsername && config.cdpPassword) {
      return createUsernamePasswordStrategy(config, logger);
    }
    logger.warn("CDP_AUTH_FLOW=username_password but credentials are incomplete");
  }

  if (flow === "oauth") {
    return oauthService;
  }

  // auto — try all available in priority order
  const chain: AuthService[] = [];
  if (config.cdpAccessToken) {
    chain.push(new DirectTokenStrategy(config.cdpAccessToken, config.cdpInstanceUrl));
    logger.info("Auth mode: direct access token available");
  }
  if (config.cdpClientId && config.cdpClientSecret) {
    if (config.cdpUsername && config.cdpPassword) {
      chain.push(createUsernamePasswordStrategy(config, logger));
      logger.info("Auth mode: username/password available");
    } else {
      chain.push(createClientCredentialsStrategy(config, logger));
      logger.info("Auth mode: client credentials available");
    }
  }
  chain.push(oauthService);
  logger.info("Auth mode: OAuth web flow (fallback)");

  return chain.length === 1 ? chain[0]! : new FallbackChain(chain);
}
