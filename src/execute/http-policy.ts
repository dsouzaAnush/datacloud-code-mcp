import type { Logger } from "pino";

export interface RetryOptions {
  maxRetries: number;
  timeoutMs: number;
  logger: Logger;
}

export class HttpRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  idempotent: boolean,
  opts: RetryOptions
): Promise<Response> {
  const maxAttempts = Math.max(1, opts.maxRetries + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

    try {
      const response = await fetchFn(url, { ...init, signal: controller.signal });
      clearTimeout(timeout);

      if (!idempotent || attempt === maxAttempts) return response;

      if (response.status === 429 || response.status >= 500) {
        opts.logger.warn({ attempt, status: response.status, url }, "Retrying idempotent request");
        await sleep(150 * attempt);
        continue;
      }

      return response;
    } catch (error) {
      clearTimeout(timeout);

      if (attempt >= maxAttempts || !idempotent) {
        if ((error as Error).name === "AbortError") {
          throw new HttpRequestError(
            `Request timed out after ${opts.timeoutMs}ms`,
            "REQUEST_TIMEOUT",
            504
          );
        }
        throw new HttpRequestError(`Request failed: ${String(error)}`, "REQUEST_FAILED", 502);
      }

      opts.logger.warn({ attempt, err: error, url }, "Retrying idempotent request after network error");
      await sleep(150 * attempt);
    }
  }

  throw new HttpRequestError("Unexpected retry termination", "REQUEST_FAILED", 502);
}

export interface ReadCacheEntry<T> {
  expiresAt: number;
  value: T;
}

export class ReadCache<T> {
  private store = new Map<string, ReadCacheEntry<T>>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 1000) {}

  enabled(): boolean {
    return this.ttlMs > 0;
  }

  get(key: string): T | undefined {
    const existing = this.store.get(key);
    if (!existing) return undefined;
    if (existing.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return existing.value;
  }

  set(key: string, value: T): void {
    this.prune();
    this.store.set(key, { expiresAt: Date.now() + this.ttlMs, value });
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.store.entries()) {
      if (v.expiresAt <= now) this.store.delete(k);
    }
    if (this.store.size <= this.maxEntries) return;
    const sorted = Array.from(this.store.entries()).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const overflow = this.store.size - this.maxEntries;
    for (let i = 0; i < overflow; i += 1) {
      const k = sorted[i]?.[0];
      if (k) this.store.delete(k);
    }
  }
}
