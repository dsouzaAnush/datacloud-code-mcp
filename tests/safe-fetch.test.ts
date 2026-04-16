import { describe, expect, test } from "vitest";
import { createSafeFetch, SafeFetchError } from "../src/sandbox/safe-fetch.js";

describe("safe-fetch", () => {
  test("allows requests to whitelisted hosts", async () => {
    const mockFetch: typeof fetch = async () => new Response("ok", { status: 200 });
    const safeFetch = createSafeFetch({ allowedHosts: ["example.salesforce.com"], fetchFn: mockFetch });

    const res = await safeFetch("https://example.salesforce.com/api/test");
    expect(res.status).toBe(200);
  });

  test("allows subdomain matching", async () => {
    const mockFetch: typeof fetch = async () => new Response("ok", { status: 200 });
    const safeFetch = createSafeFetch({ allowedHosts: ["salesforce.com"], fetchFn: mockFetch });

    const res = await safeFetch("https://orgid.c360a.salesforce.com/api/test");
    expect(res.status).toBe(200);
  });

  test("blocks requests to unlisted hosts", async () => {
    const mockFetch: typeof fetch = async () => new Response("ok", { status: 200 });
    const safeFetch = createSafeFetch({ allowedHosts: ["salesforce.com"], fetchFn: mockFetch });

    await expect(safeFetch("https://evil.example.com/steal")).rejects.toThrow(SafeFetchError);
  });
});
