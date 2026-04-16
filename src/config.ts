import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

loadDotEnv();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),

  // Empty string means "use the bundled spec next to the compiled schema service".
  DATACLOUD_OPENAPI_PATH: z.string().default(""),
  DATACLOUD_DOCS_PATH: z.string().default(""),
  DATACLOUD_API_BASE_URL: z.url().default("https://login.salesforce.com"),
  DATACLOUD_ACCEPT_HEADER: z.string().default("application/json"),
  SCHEMA_REFRESH_MS: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),
  CATALOG_CACHE_PATH: z.string().default("/tmp/datacloud-catalog-cache.json"),

  ALLOW_WRITES: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  READ_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(5000),
  EXECUTE_MAX_BODY_BYTES: z.coerce.number().int().positive().default(48_000),
  EXECUTE_BODY_PREVIEW_CHARS: z.coerce.number().int().positive().default(6000),
  USER_ID_HEADER: z.string().default("x-user-id"),

  SANDBOX_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  SANDBOX_MAX_OUTPUT_BYTES: z.coerce.number().int().positive().default(96_000),
  SANDBOX_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  TOKEN_STORE_PATH: z.string().default("/tmp/datacloud-tokens.json"),
  TOKEN_ENCRYPTION_KEY_BASE64: z.string().optional(),

  SALESFORCE_OAUTH_CLIENT_ID: z.string().optional(),
  SALESFORCE_OAUTH_CLIENT_SECRET: z.string().optional(),
  SALESFORCE_OAUTH_SCOPE: z
    .string()
    .default("api cdp_query_api cdp_profile_api cdp_ingest_api refresh_token"),
  SALESFORCE_OAUTH_AUTHORIZE_URL: z
    .url()
    .default("https://login.salesforce.com/services/oauth2/authorize"),
  SALESFORCE_OAUTH_TOKEN_URL: z
    .url()
    .default("https://login.salesforce.com/services/oauth2/token"),
  SALESFORCE_OAUTH_REDIRECT_URI: z
    .url()
    .default("http://localhost:3000/oauth/callback"),
  DATACLOUD_TOKEN_EXCHANGE_PATH: z.string().default("/services/a360/token"),

  // d360-compatible auth: same env var names as the Java d360-mcp-server.
  // CDP_AUTH_FLOW: "access_token" | "client_credentials" | "username_password" | "auto" | "oauth"
  CDP_AUTH_FLOW: z.enum(["auto", "access_token", "client_credentials", "username_password", "oauth"]).default("auto"),
  CDP_LOGIN_URL: z.url().default("https://login.salesforce.com"),
  CDP_CLIENT_ID: z.string().optional(),
  CDP_CLIENT_SECRET: z.string().optional(),
  CDP_USERNAME: z.string().optional(),
  CDP_PASSWORD: z.string().optional(),
  CDP_ACCESS_TOKEN: z.string().optional(),
  CDP_INSTANCE_URL: z.string().optional()
});

const parsed = envSchema.parse(process.env);

export const appConfig = {
  port: parsed.PORT,
  host: parsed.HOST,
  logLevel: parsed.LOG_LEVEL,

  dataCloudOpenApiPath: parsed.DATACLOUD_OPENAPI_PATH,
  dataCloudDocsPath: parsed.DATACLOUD_DOCS_PATH,
  dataCloudApiBaseUrl: parsed.DATACLOUD_API_BASE_URL,
  dataCloudAcceptHeader: parsed.DATACLOUD_ACCEPT_HEADER,
  schemaRefreshMs: parsed.SCHEMA_REFRESH_MS,
  catalogCachePath: parsed.CATALOG_CACHE_PATH,

  allowWrites: parsed.ALLOW_WRITES,
  requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
  maxRetries: parsed.MAX_RETRIES,
  readCacheTtlMs: parsed.READ_CACHE_TTL_MS,
  executeMaxBodyBytes: parsed.EXECUTE_MAX_BODY_BYTES,
  executeBodyPreviewChars: parsed.EXECUTE_BODY_PREVIEW_CHARS,
  userIdHeader: parsed.USER_ID_HEADER.toLowerCase(),

  sandboxTimeoutMs: parsed.SANDBOX_TIMEOUT_MS,
  sandboxMaxOutputBytes: parsed.SANDBOX_MAX_OUTPUT_BYTES,
  sandboxFetchTimeoutMs: parsed.SANDBOX_FETCH_TIMEOUT_MS,

  tokenStorePath: parsed.TOKEN_STORE_PATH,
  tokenEncryptionKeyBase64: parsed.TOKEN_ENCRYPTION_KEY_BASE64,

  oauthClientId: parsed.SALESFORCE_OAUTH_CLIENT_ID,
  oauthClientSecret: parsed.SALESFORCE_OAUTH_CLIENT_SECRET,
  oauthScope: parsed.SALESFORCE_OAUTH_SCOPE,
  oauthAuthorizeUrl: parsed.SALESFORCE_OAUTH_AUTHORIZE_URL,
  oauthTokenUrl: parsed.SALESFORCE_OAUTH_TOKEN_URL,
  oauthRedirectUri: parsed.SALESFORCE_OAUTH_REDIRECT_URI,
  dataCloudTokenExchangePath: parsed.DATACLOUD_TOKEN_EXCHANGE_PATH,

  cdpAuthFlow: parsed.CDP_AUTH_FLOW,
  cdpLoginUrl: parsed.CDP_LOGIN_URL,
  cdpClientId: parsed.CDP_CLIENT_ID,
  cdpClientSecret: parsed.CDP_CLIENT_SECRET,
  cdpUsername: parsed.CDP_USERNAME,
  cdpPassword: parsed.CDP_PASSWORD,
  cdpAccessToken: parsed.CDP_ACCESS_TOKEN,
  cdpInstanceUrl: parsed.CDP_INSTANCE_URL
};

export type AppConfig = typeof appConfig;
