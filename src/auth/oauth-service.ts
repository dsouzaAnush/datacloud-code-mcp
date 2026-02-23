import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { AuthContext, AuthStatusResponse, OAuthTokenRecord } from "../types.js";
import { EncryptedTokenStore } from "./token-store.js";

interface PendingState {
  userId: string;
  createdAtMs: number;
}

interface SalesforceTokenEndpointResponse {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  instance_url?: string;
  id?: string;
}

interface DataCloudTokenExchangeResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  instance_url?: string;
}

function toIsoFromNow(seconds?: number): string | undefined {
  if (!seconds || Number.isNaN(seconds)) {
    return undefined;
  }
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function parseScope(scope: string | undefined): string[] {
  if (!scope) {
    return [];
  }
  return scope
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export class DataCloudOAuthService {
  private stateStore = new Map<string, PendingState>();

  constructor(
    private readonly config: AppConfig,
    private readonly tokenStore: EncryptedTokenStore,
    private readonly logger: Logger,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  buildAuthorizationUrl(userId: string): string {
    if (!this.config.oauthClientId) {
      throw new Error("SALESFORCE_OAUTH_CLIENT_ID is required for OAuth authorization");
    }

    const state = randomBytes(16).toString("hex");
    this.stateStore.set(state, {
      userId,
      createdAtMs: Date.now()
    });

    const url = new URL(this.config.oauthAuthorizeUrl);
    url.searchParams.set("client_id", this.config.oauthClientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.config.oauthScope);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", this.config.oauthRedirectUri);

    return url.toString();
  }

  async handleOAuthCallback(code: string, state: string): Promise<{ userId: string }> {
    const pending = this.stateStore.get(state);
    if (!pending) {
      throw new Error("Invalid or expired OAuth state");
    }

    this.stateStore.delete(state);

    if (Date.now() - pending.createdAtMs > 10 * 60 * 1000) {
      throw new Error("OAuth state expired");
    }

    const token = await this.exchangeAuthorizationCodeForDataCloudToken(code);
    await this.tokenStore.set(pending.userId, token);

    return { userId: pending.userId };
  }

  async getAuthContext(userId: string): Promise<AuthContext | null> {
    const record = await this.tokenStore.get(userId);
    if (!record) {
      return null;
    }

    if (!record.expiresAt) {
      return {
        accessToken: record.accessToken,
        instanceUrl: record.instanceUrl
      };
    }

    const expiresAtMs = Date.parse(record.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      return {
        accessToken: record.accessToken,
        instanceUrl: record.instanceUrl
      };
    }

    const thresholdMs = 60 * 1000;
    if (Date.now() < expiresAtMs - thresholdMs) {
      return {
        accessToken: record.accessToken,
        instanceUrl: record.instanceUrl
      };
    }

    if (!record.refreshToken || !record.salesforceInstanceUrl) {
      this.logger.warn(
        { userId },
        "Data Cloud token expired and refresh prerequisites are missing"
      );
      return null;
    }

    const refreshed = await this.refreshDataCloudToken(record.refreshToken, record.salesforceInstanceUrl);
    await this.tokenStore.set(userId, refreshed);

    return {
      accessToken: refreshed.accessToken,
      instanceUrl: refreshed.instanceUrl
    };
  }

  async getAuthStatus(userId: string): Promise<AuthStatusResponse> {
    const record = await this.tokenStore.get(userId);
    if (!record) {
      return {
        authenticated: false,
        scopes: []
      };
    }

    return {
      authenticated: true,
      scopes: record.scope,
      expires_at: record.expiresAt,
      instance_url: record.instanceUrl,
      salesforce_instance_url: record.salesforceInstanceUrl
    };
  }

  private async exchangeAuthorizationCodeForDataCloudToken(code: string): Promise<OAuthTokenRecord> {
    if (!this.config.oauthClientId || !this.config.oauthClientSecret) {
      throw new Error(
        "SALESFORCE_OAUTH_CLIENT_ID and SALESFORCE_OAUTH_CLIENT_SECRET are required"
      );
    }

    const payload = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: this.config.oauthClientId,
      client_secret: this.config.oauthClientSecret,
      redirect_uri: this.config.oauthRedirectUri
    });

    const response = await this.fetchFn(this.config.oauthTokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: payload.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Salesforce OAuth token exchange failed: ${response.status} ${errorText}`);
    }

    const salesforceToken = (await response.json()) as SalesforceTokenEndpointResponse;
    if (!salesforceToken.access_token || !salesforceToken.instance_url) {
      throw new Error("Salesforce OAuth token exchange returned incomplete response");
    }

    return this.exchangeSalesforceForDataCloud(salesforceToken);
  }

  private async refreshDataCloudToken(
    refreshToken: string,
    salesforceInstanceUrl: string
  ): Promise<OAuthTokenRecord> {
    if (!this.config.oauthClientId || !this.config.oauthClientSecret) {
      throw new Error(
        "SALESFORCE_OAUTH_CLIENT_ID and SALESFORCE_OAUTH_CLIENT_SECRET are required"
      );
    }

    const payload = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.oauthClientId,
      client_secret: this.config.oauthClientSecret
    });

    const response = await this.fetchFn(this.config.oauthTokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: payload.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Salesforce OAuth refresh failed: ${response.status} ${errorText}`);
    }

    const salesforceToken = (await response.json()) as SalesforceTokenEndpointResponse;
    if (!salesforceToken.access_token) {
      throw new Error("Salesforce OAuth refresh returned no access token");
    }

    return this.exchangeSalesforceForDataCloud({
      ...salesforceToken,
      refresh_token: salesforceToken.refresh_token ?? refreshToken,
      instance_url: salesforceToken.instance_url ?? salesforceInstanceUrl
    });
  }

  private async exchangeSalesforceForDataCloud(
    salesforceToken: SalesforceTokenEndpointResponse
  ): Promise<OAuthTokenRecord> {
    if (!salesforceToken.instance_url) {
      throw new Error("Salesforce token exchange response missing instance_url");
    }

    const exchangeUrl = new URL(this.config.dataCloudTokenExchangePath, salesforceToken.instance_url);
    const payload = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: salesforceToken.access_token,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token"
    });

    const response = await this.fetchFn(exchangeUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Bearer ${salesforceToken.access_token}`
      },
      body: payload.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Data Cloud token exchange failed: ${response.status} ${errorText}`);
    }

    const dataCloudToken = (await response.json()) as DataCloudTokenExchangeResponse;
    if (!dataCloudToken.access_token) {
      throw new Error("Data Cloud token exchange returned no access token");
    }

    return {
      accessToken: dataCloudToken.access_token,
      tokenType: dataCloudToken.token_type ?? "Bearer",
      refreshToken: salesforceToken.refresh_token,
      scope: parseScope(dataCloudToken.scope ?? salesforceToken.scope),
      expiresAt: toIsoFromNow(dataCloudToken.expires_in),
      obtainedAt: new Date().toISOString(),
      instanceUrl: dataCloudToken.instance_url ?? salesforceToken.instance_url,
      salesforceInstanceUrl: salesforceToken.instance_url,
      idUrl: salesforceToken.id
    };
  }

  purgeExpiredState(): void {
    const now = Date.now();
    for (const [state, pending] of this.stateStore.entries()) {
      if (now - pending.createdAtMs > 10 * 60 * 1000) {
        this.stateStore.delete(state);
      }
    }
  }
}
