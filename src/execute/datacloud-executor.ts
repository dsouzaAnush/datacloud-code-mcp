import AjvImport, { type ValidateFunction } from "ajv";
import addFormatsImport from "ajv-formats";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type {
  AuthContext,
  ExecuteRequest,
  ExecuteResponse,
  JsonSchema,
  PlatformOperation
} from "../types.js";
import { createWriteConfirmationToken } from "../safety/write-confirmation.js";

const SENSITIVE_HEADER_PATTERN = /authorization|cookie|set-cookie|x-api-key/i;
const SENSITIVE_BODY_KEY_PATTERN = /(token|authorization|password|secret)/i;

interface CachedReadEntry {
  expiresAt: number;
  response: ExecuteResponse;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number
  ) {
    super(message);
  }
}

function redactBody(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactBody(item));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_BODY_KEY_PATTERN.test(key)) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = redactBody(item);
      }
    }
    return output;
  }

  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeSerialize(value: unknown): string | undefined {
  try {
    if (typeof value === "string") {
      return value;
    }
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function cloneExecuteResponse(response: ExecuteResponse): ExecuteResponse {
  if (typeof structuredClone === "function") {
    return structuredClone(response);
  }

  return JSON.parse(JSON.stringify(response)) as ExecuteResponse;
}

interface ExecutorDeps {
  config: AppConfig;
  logger: Logger;
  getOperation: (operationId: string) => PlatformOperation | undefined;
  getRootSchema: () => JsonSchema | undefined;
  getAuthContext: (userId: string) => Promise<AuthContext | null>;
  fetchFn?: typeof fetch;
}

function requiresAuth(pathTemplate: string): boolean {
  if (pathTemplate.startsWith("/.well-known/")) {
    return false;
  }
  if (pathTemplate.startsWith("/services/oauth2/authorize")) {
    return false;
  }
  return true;
}

export class DataCloudExecutor {
  private readonly ajv: {
    compile: (schema: object) => ValidateFunction;
  };

  private readonly validatorCache = new Map<string, ValidateFunction>();

  private readonly fetchFn: typeof fetch;

  private readonly readCache = new Map<string, CachedReadEntry>();

  constructor(private readonly deps: ExecutorDeps) {
    const Ajv = AjvImport as unknown as new (options: Record<string, unknown>) => {
      compile: (schema: object) => ValidateFunction;
    };
    this.ajv = new Ajv({
      allErrors: true,
      strict: false,
      allowUnionTypes: true
    });
    const addFormats = addFormatsImport as unknown as (ajv: {
      compile: (schema: object) => ValidateFunction;
    }) => void;
    addFormats(this.ajv);
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  async execute(input: ExecuteRequest, userId: string): Promise<ExecuteResponse> {
    const operation = this.deps.getOperation(input.operation_id);
    if (!operation) {
      throw new ToolError(`Unknown operation_id: ${input.operation_id}`, "OPERATION_NOT_FOUND", 404);
    }

    const pathParams = input.path_params ?? {};
    const queryParams = input.query_params ?? {};

    this.validatePathParams(operation, pathParams);
    this.validateQueryParams(operation, queryParams);
    this.validateBody(operation, input.body);

    const renderedPath = this.renderPath(operation, pathParams);

    const authContext = await this.deps.getAuthContext(userId);
    const needsAuth = requiresAuth(operation.pathTemplate);

    if (needsAuth && !authContext) {
      throw new ToolError(
        "No Data Cloud token found for user. Complete /oauth/start first or seed token.",
        "AUTH_REQUIRED",
        401
      );
    }

    const url = new URL(renderedPath, authContext?.instanceUrl ?? this.deps.config.dataCloudApiBaseUrl);
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, String(value));
    }

    const requestEnvelope = {
      method: operation.method,
      url: url.toString(),
      operation_id: operation.operationId
    };

    const isDryRun = input.dry_run ?? false;
    if (isDryRun) {
      const warnings: string[] = [];
      let dryRunBody: unknown = { dry_run: true };

      if (operation.isMutating) {
        const token = createWriteConfirmationToken({
          secret: this.deps.config.writeConfirmationSecret,
          userId,
          operationId: operation.operationId,
          pathParams,
          queryParams,
          body: input.body ?? null
        });

        dryRunBody = {
          dry_run: true,
          confirm_write_token: token
        };

        if (!this.deps.config.allowWrites) {
          warnings.push("Writes are disabled by ALLOW_WRITES=false");
        }
      }

      return {
        request: requestEnvelope,
        status: 0,
        headers: {},
        body: dryRunBody,
        warnings
      };
    }

    if (operation.isMutating) {
      if (!this.deps.config.allowWrites) {
        throw new ToolError("Write operation blocked: ALLOW_WRITES=false", "WRITES_DISABLED", 403);
      }

      const expected = createWriteConfirmationToken({
        secret: this.deps.config.writeConfirmationSecret,
        userId,
        operationId: operation.operationId,
        pathParams,
        queryParams,
        body: input.body ?? null
      });

      if (input.confirm_write_token !== expected) {
        throw new ToolError(
          "Invalid or missing confirm_write_token. Run with dry_run=true first.",
          "WRITE_CONFIRMATION_REQUIRED",
          403
        );
      }
    }

    const readCacheKey = this.getReadCacheKey(operation, requestEnvelope, userId);
    if (readCacheKey) {
      const cached = this.getReadCacheEntry(readCacheKey);
      if (cached) {
        return cached;
      }
    }

    const headers: HeadersInit = {
      Accept: this.deps.config.dataCloudAcceptHeader
    };

    if (authContext?.accessToken) {
      (headers as Record<string, string>).Authorization = `Bearer ${authContext.accessToken}`;
    }

    const init: RequestInit = {
      method: operation.method,
      headers
    };

    if (input.body !== undefined) {
      (headers as Record<string, string>)["Content-Type"] = "application/json";
      init.body = JSON.stringify(input.body);
    }

    const idempotent = ["GET", "HEAD"].includes(operation.method);
    const response = await this.fetchWithRetry(url.toString(), init, idempotent);

    let parsedBody: unknown = null;
    if (response.status !== 204) {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        parsedBody = await response.json().catch(async () => response.text());
      } else {
        const text = await response.text();
        parsedBody = text.length > 0 ? text : null;
      }
    }

    const cleanHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (!SENSITIVE_HEADER_PATTERN.test(key)) {
        cleanHeaders[key] = value;
      }
    });

    const requestId =
      response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;

    const redactedBody = redactBody(parsedBody);
    const truncated = this.truncateBodyForOutput(redactedBody);

    if (!response.ok) {
      throw new ToolError(
        `Data Cloud API request failed: HTTP ${response.status}${this.buildErrorSuffix(redactedBody)}`,
        "DATACLOUD_API_ERROR",
        response.status
      );
    }

    const result: ExecuteResponse = {
      request: requestEnvelope,
      status: response.status,
      headers: cleanHeaders,
      body: truncated.body,
      request_id: requestId,
      ...(truncated.warnings.length > 0 ? { warnings: truncated.warnings } : {})
    };

    if (readCacheKey) {
      this.setReadCacheEntry(readCacheKey, result);
    }

    return result;
  }

  private getReadCacheKey(
    operation: PlatformOperation,
    requestEnvelope: ExecuteResponse["request"],
    userId: string
  ): string | undefined {
    if (this.deps.config.readCacheTtlMs <= 0) {
      return undefined;
    }

    if (operation.isMutating || !["GET", "HEAD"].includes(operation.method)) {
      return undefined;
    }

    return `${userId}:${requestEnvelope.operation_id}:${requestEnvelope.url}`;
  }

  private getReadCacheEntry(key: string): ExecuteResponse | undefined {
    const existing = this.readCache.get(key);
    if (!existing) {
      return undefined;
    }

    if (existing.expiresAt <= Date.now()) {
      this.readCache.delete(key);
      return undefined;
    }

    const copy = cloneExecuteResponse(existing.response);
    copy.warnings = [...(copy.warnings ?? []), "served_from_read_cache"];
    return copy;
  }

  private setReadCacheEntry(key: string, response: ExecuteResponse): void {
    this.pruneReadCache();

    this.readCache.set(key, {
      expiresAt: Date.now() + this.deps.config.readCacheTtlMs,
      response: cloneExecuteResponse(response)
    });
  }

  private pruneReadCache(): void {
    const now = Date.now();

    for (const [key, entry] of this.readCache.entries()) {
      if (entry.expiresAt <= now) {
        this.readCache.delete(key);
      }
    }

    if (this.readCache.size <= 1000) {
      return;
    }

    const entries = Array.from(this.readCache.entries()).sort(
      (a, b) => a[1].expiresAt - b[1].expiresAt
    );

    const overflow = this.readCache.size - 1000;
    for (let index = 0; index < overflow; index += 1) {
      const staleKey = entries[index]?.[0];
      if (staleKey) {
        this.readCache.delete(staleKey);
      }
    }
  }

  private truncateBodyForOutput(value: unknown): { body: unknown; warnings: string[] } {
    const serialized = safeSerialize(value);
    if (!serialized) {
      return {
        body: value,
        warnings: []
      };
    }

    const sizeBytes = Buffer.byteLength(serialized, "utf8");
    if (sizeBytes <= this.deps.config.executeMaxBodyBytes) {
      return {
        body: value,
        warnings: []
      };
    }

    const preview = serialized.slice(0, this.deps.config.executeBodyPreviewChars);

    return {
      body: {
        truncated: true,
        original_size_bytes: sizeBytes,
        preview,
        preview_is_partial: preview.length < serialized.length
      },
      warnings: [
        `response_body_truncated: ${sizeBytes} bytes exceeded EXECUTE_MAX_BODY_BYTES=${this.deps.config.executeMaxBodyBytes}`
      ]
    };
  }

  private buildErrorSuffix(body: unknown): string {
    const serialized = safeSerialize(body);
    if (!serialized || serialized.length === 0) {
      return "";
    }

    const preview = serialized.slice(0, this.deps.config.executeBodyPreviewChars);
    return ` body_preview=${preview}`;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    idempotent: boolean
  ): Promise<Response> {
    const maxAttempts = Math.max(1, this.deps.config.maxRetries + 1);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.deps.config.requestTimeoutMs);

      try {
        const response = await this.fetchFn(url, {
          ...init,
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (!idempotent || attempt === maxAttempts) {
          return response;
        }

        if (response.status === 429 || response.status >= 500) {
          this.deps.logger.warn({ attempt, status: response.status, url }, "Retrying idempotent request");
          await sleep(150 * attempt);
          continue;
        }

        return response;
      } catch (error) {
        clearTimeout(timeout);

        if (attempt >= maxAttempts || !idempotent) {
          if ((error as Error).name === "AbortError") {
            throw new ToolError(
              `Data Cloud API request timeout after ${this.deps.config.requestTimeoutMs}ms`,
              "REQUEST_TIMEOUT",
              504
            );
          }

          throw new ToolError(`Data Cloud API request failed: ${String(error)}`, "REQUEST_FAILED", 502);
        }

        this.deps.logger.warn(
          { attempt, err: error, url },
          "Retrying idempotent request after network error"
        );
        await sleep(150 * attempt);
      }
    }

    throw new ToolError("Unexpected retry termination", "REQUEST_FAILED", 502);
  }

  private validatePathParams(
    operation: PlatformOperation,
    pathParams: Record<string, string>
  ): void {
    for (const param of operation.pathParams) {
      if (!(param.name in pathParams) || pathParams[param.name] === "") {
        throw new ToolError(`Missing required path parameter: ${param.name}`, "VALIDATION_ERROR", 400);
      }
    }
  }

  private validateQueryParams(
    operation: PlatformOperation,
    queryParams: Record<string, string | number | boolean>
  ): void {
    for (const [key, value] of Object.entries(queryParams)) {
      if (!["string", "number", "boolean"].includes(typeof value)) {
        throw new ToolError(`Invalid query parameter type for ${key}`, "VALIDATION_ERROR", 400);
      }
    }

    for (const required of operation.queryParams.filter((param) => param.required)) {
      if (!(required.name in queryParams)) {
        throw new ToolError(
          `Missing required query parameter: ${required.name}`,
          "VALIDATION_ERROR",
          400
        );
      }
    }
  }

  private validateBody(operation: PlatformOperation, body: unknown): void {
    if (!operation.requestSchema) {
      return;
    }

    const validator = this.getValidator(operation);
    const candidate = body ?? {};

    const valid = validator(candidate);
    if (!valid) {
      const detail = validator.errors
        ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ");
      throw new ToolError(
        `Request body validation failed: ${detail ?? "unknown"}`,
        "VALIDATION_ERROR",
        400
      );
    }
  }

  private getValidator(operation: PlatformOperation): ValidateFunction {
    const existing = this.validatorCache.get(operation.operationId);
    if (existing) {
      return existing;
    }

    const rootSchema = this.deps.getRootSchema();
    if (!rootSchema) {
      throw new ToolError("Schema catalog is not initialized", "SCHEMA_UNAVAILABLE", 503);
    }

    const root = rootSchema as {
      definitions?: Record<string, unknown>;
      components?: Record<string, unknown>;
      $defs?: Record<string, unknown>;
    };

    const validate = this.ajv.compile({
      ...(operation.requestSchema ?? {}),
      definitions: root.definitions,
      components: root.components,
      $defs: root.$defs
    });

    this.validatorCache.set(operation.operationId, validate);
    return validate;
  }

  private renderPath(
    operation: PlatformOperation,
    pathParams: Record<string, string>
  ): string {
    let output = operation.pathTemplate;

    for (const param of operation.pathParams) {
      const raw = pathParams[param.name];
      if (raw === undefined) {
        continue;
      }
      output = output.replaceAll(`{${param.name}}`, encodeURIComponent(raw));
    }

    return output;
  }
}
