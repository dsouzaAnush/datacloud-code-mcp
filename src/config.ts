import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

loadDotEnv();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),

  DATACLOUD_OPENAPI_PATH: z
    .string()
    .default("/Users/anush.dsouza/startup/Aura12/work/datacloud-docs/openapi/data360-api.yaml"),
  DATACLOUD_DOCS_PATH: z
    .string()
    .default("/Users/anush.dsouza/startup/Aura12/work/datacloud-docs"),
  DATACLOUD_API_BASE_URL: z.url().default("https://login.salesforce.com"),
  DATACLOUD_ACCEPT_HEADER: z.string().default("application/json"),
  SCHEMA_REFRESH_MS: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),
  CATALOG_CACHE_PATH: z.string().default("./data/catalog-cache.json"),

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
  WRITE_CONFIRMATION_SECRET: z.string().min(8).default("local-dev-secret"),

  TOKEN_STORE_PATH: z.string().default("./data/tokens.json"),
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
  DATACLOUD_TOKEN_EXCHANGE_PATH: z.string().default("/services/a360/token")
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
  writeConfirmationSecret: parsed.WRITE_CONFIRMATION_SECRET,

  tokenStorePath: parsed.TOKEN_STORE_PATH,
  tokenEncryptionKeyBase64: parsed.TOKEN_ENCRYPTION_KEY_BASE64,

  oauthClientId: parsed.SALESFORCE_OAUTH_CLIENT_ID,
  oauthClientSecret: parsed.SALESFORCE_OAUTH_CLIENT_SECRET,
  oauthScope: parsed.SALESFORCE_OAUTH_SCOPE,
  oauthAuthorizeUrl: parsed.SALESFORCE_OAUTH_AUTHORIZE_URL,
  oauthTokenUrl: parsed.SALESFORCE_OAUTH_TOKEN_URL,
  oauthRedirectUri: parsed.SALESFORCE_OAUTH_REDIRECT_URI,
  dataCloudTokenExchangePath: parsed.DATACLOUD_TOKEN_EXCHANGE_PATH
};

export type AppConfig = typeof appConfig;
