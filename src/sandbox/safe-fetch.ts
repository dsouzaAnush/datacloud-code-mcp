export interface SafeFetchOptions {
  allowedHosts: string[];
  fetchFn?: typeof fetch;
}

export class SafeFetchError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

export function createSafeFetch(opts: SafeFetchOptions): typeof fetch {
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const fetchFn = opts.fetchFn ?? fetch;

  const safe: typeof fetch = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? new URL(input) : new URL(input.url);
    const host = url.hostname.toLowerCase();
    const allowedMatch = Array.from(allowed).some(
      (h) => host === h || host.endsWith("." + h)
    );
    if (!allowedMatch) {
      throw new SafeFetchError(
        `Forbidden: outbound request to ${host} blocked. Allow-list: ${Array.from(allowed).join(", ")}`,
        "OUTBOUND_FETCH_BLOCKED",
        403
      );
    }
    return fetchFn(input as RequestInfo, init);
  };

  return safe;
}
