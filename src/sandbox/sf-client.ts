import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { AuthContext } from "../types.js";
import { redactBody, redactHeaders, safeSerialize } from "../execute/redaction.js";
import { fetchWithRetry, ReadCache, type RetryOptions } from "../execute/http-policy.js";
import { createSafeFetch } from "./safe-fetch.js";

export interface SalesforceRequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;
  rawBody?: boolean;
}

export interface SalesforceResponse {
  success: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  request_id?: string;
  warnings?: string[];
}

export interface SfClientDeps {
  config: AppConfig;
  logger: Logger;
  authContext: AuthContext;
  userId: string;
  fetchFn?: typeof fetch;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function buildSalesforceClient(deps: SfClientDeps): {
  request: (options: SalesforceRequestOptions) => Promise<SalesforceResponse>;
  baseUrl: string;
} {
  const baseUrl = deps.authContext.instanceUrl ?? deps.config.dataCloudApiBaseUrl;
  const instanceHost = new URL(baseUrl).hostname;

  const safeFetch = createSafeFetch({
    allowedHosts: [instanceHost, "salesforce.com", "force.com"],
    fetchFn: deps.fetchFn ?? fetch
  });

  const retryOpts: RetryOptions = {
    maxRetries: deps.config.maxRetries,
    timeoutMs: deps.config.requestTimeoutMs,
    logger: deps.logger
  };

  const readCache = new ReadCache<SalesforceResponse>(deps.config.readCacheTtlMs);

  async function request(options: SalesforceRequestOptions): Promise<SalesforceResponse> {
    const method = options.method.toUpperCase();
    const isMutating = MUTATING_METHODS.has(method);

    if (isMutating && !deps.config.allowWrites) {
      throw Object.assign(
        new Error("Write operation blocked. Set ALLOW_WRITES=true."),
        { code: "WRITES_DISABLED", status: 403 }
      );
    }

    const url = new URL(options.path, baseUrl);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const urlStr = url.toString();
    const cacheKey = !isMutating && readCache.enabled()
      ? `${deps.userId}:${method}:${urlStr}`
      : undefined;

    if (cacheKey) {
      const cached = readCache.get(cacheKey);
      if (cached) {
        return {
          ...cached,
          warnings: [...(cached.warnings ?? []), "served_from_read_cache"]
        };
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${deps.authContext.accessToken}`,
      Accept: deps.config.dataCloudAcceptHeader
    };

    if (options.contentType) {
      headers["Content-Type"] = options.contentType;
    } else if (options.body && !options.rawBody) {
      headers["Content-Type"] = "application/json";
    }

    let requestBody: string | undefined;
    if (options.rawBody && options.body !== undefined) {
      requestBody = String(options.body);
    } else if (options.body !== undefined) {
      requestBody = JSON.stringify(options.body);
    }

    const response = await fetchWithRetry(
      safeFetch,
      urlStr,
      { method, headers, body: requestBody },
      !isMutating,
      retryOpts
    );

    let parsedBody: unknown = null;
    if (response.status !== 204) {
      const ct = response.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        parsedBody = await response.json().catch(async () => response.text());
      } else {
        const text = await response.text();
        parsedBody = text.length > 0 ? text : null;
      }
    }

    const cleanHeaders = redactHeaders(response.headers);
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
    const redactedBody = redactBody(parsedBody);
    const truncated = truncateForSandbox(redactedBody, deps.config.executeMaxBodyBytes, deps.config.executeBodyPreviewChars);

    if (!response.ok) {
      const preview = safeSerialize(redactedBody)?.slice(0, deps.config.executeBodyPreviewChars);
      throw Object.assign(
        new Error(`Salesforce API error: HTTP ${response.status} ${preview ?? ""}`),
        { code: "SALESFORCE_API_ERROR", status: response.status }
      );
    }

    const result: SalesforceResponse = {
      success: true,
      status: response.status,
      headers: cleanHeaders,
      body: truncated.body,
      request_id: requestId,
      ...(truncated.warnings.length > 0 ? { warnings: truncated.warnings } : {})
    };

    if (cacheKey) {
      readCache.set(cacheKey, result);
    }

    return result;
  }

  return { request, baseUrl };
}

function truncateForSandbox(
  value: unknown,
  maxBytes: number,
  previewChars: number
): { body: unknown; warnings: string[] } {
  const serialized = safeSerialize(value);
  if (!serialized) return { body: value, warnings: [] };

  const sizeBytes = Buffer.byteLength(serialized, "utf8");
  if (sizeBytes <= maxBytes) return { body: value, warnings: [] };

  return {
    body: {
      truncated: true,
      original_size_bytes: sizeBytes,
      preview: serialized.slice(0, previewChars)
    },
    warnings: [`response_body_truncated: ${sizeBytes} bytes exceeded limit of ${maxBytes}`]
  };
}
