import { describe, expect, test } from "vitest";
import { runUserCode } from "../src/sandbox/runner.js";

const defaultOpts = { timeoutMs: 5000 };

describe("sandbox runner", () => {
  test("runs a simple async arrow and returns result", async () => {
    const res = await runUserCode("async () => 42", {}, defaultOpts);
    expect(res.result).toBe(42);
    expect(res.err).toBeUndefined();
  });

  test("returns error for invalid JS syntax", async () => {
    const res = await runUserCode("async () => {{{", {}, defaultOpts);
    expect(res.err).toBeDefined();
  });

  test("catches thrown errors in user code", async () => {
    const res = await runUserCode(
      "async () => { throw new Error('boom'); }",
      {},
      defaultOpts
    );
    expect(res.err).toBe("boom");
  });

  test("injects globals into the sandbox", async () => {
    const res = await runUserCode(
      "async () => greeting",
      { greeting: "hello" },
      defaultOpts
    );
    expect(res.result).toBe("hello");
  });

  test("spec object is searchable inside sandbox", async () => {
    const spec = {
      paths: {
        "/services/data/v64.0/ssot/segments": {
          get: { summary: "List segments", tags: ["segments"] },
          post: { summary: "Create segment", tags: ["segments"] }
        }
      }
    };
    const res = await runUserCode(
      `async () => {
        const results = [];
        for (const [path, methods] of Object.entries(spec.paths)) {
          for (const [method, op] of Object.entries(methods)) {
            results.push({ method: method.toUpperCase(), path, summary: op.summary });
          }
        }
        return results;
      }`,
      { spec },
      defaultOpts
    );
    expect(res.err).toBeUndefined();
    const results = res.result as Array<{ method: string; path: string; summary: string }>;
    expect(results).toHaveLength(2);
    expect(results[0]?.method).toBe("GET");
  });

  test("denies access to process", async () => {
    const res = await runUserCode(
      "async () => typeof process",
      {},
      defaultOpts
    );
    expect(res.result).toBe("undefined");
  });

  test("denies access to require", async () => {
    const res = await runUserCode(
      "async () => typeof require",
      {},
      defaultOpts
    );
    expect(res.result).toBe("undefined");
  });

  test("times out long-running code", async () => {
    const res = await runUserCode(
      "async () => { while (true) {} }",
      {},
      { timeoutMs: 200 }
    );
    expect(res.err).toBeDefined();
  });

  test("injected salesforce.request is callable", async () => {
    const mockRequest = async (opts: unknown) => ({
      success: true,
      status: 200,
      body: { mock: true, opts }
    });
    const res = await runUserCode(
      `async () => salesforce.request({ method: "GET", path: "/test" })`,
      { salesforce: { request: mockRequest } },
      defaultOpts
    );
    expect(res.err).toBeUndefined();
    const body = res.result as { success: boolean; body: { mock: boolean } };
    expect(body.success).toBe(true);
  });

  test("cannot pollute host Object.prototype", async () => {
    const res = await runUserCode(
      `async () => { Object.prototype.polluted = true; return "done"; }`,
      {},
      defaultOpts
    );
    // Sandbox uses fresh builtins; host prototype should be unaffected
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // The code may succeed or fail depending on VM strictness — either is acceptable
    // as long as host prototype is clean.
  });

  test("result serialization prevents host realm object leaks", async () => {
    // node:vm is NOT a security boundary — host functions passed as globals
    // return host-realm Promises whose prototype chain reaches the host Function.
    // The WRAPPER's JSON.stringify ensures the RESULT is always a plain JSON value,
    // not a live host object. The production mcp-server.ts additionally wraps
    // salesforce.request() with JSON.parse(JSON.stringify(res)) to sever the
    // prototype chain on intermediate values.
    const res = await runUserCode(
      `async () => {
        const obj = { a: 1, b: [2, 3], c: { d: true } };
        return obj;
      }`,
      {},
      defaultOpts
    );
    expect(res.err).toBeUndefined();
    // Result is plain JSON — no prototype chain to host realm
    expect(typeof res.result).toBe("object");
    expect(JSON.stringify(res.result)).toBe('{"a":1,"b":[2,3],"c":{"d":true}}');
  });

  test("returns serializable results (no host realm leaks)", async () => {
    const res = await runUserCode(
      `async () => ({ nested: { arr: [1, 2, 3], str: "test" } })`,
      {},
      defaultOpts
    );
    expect(res.err).toBeUndefined();
    const obj = res.result as { nested: { arr: number[]; str: string } };
    expect(obj.nested.arr).toEqual([1, 2, 3]);
    expect(obj.nested.str).toBe("test");
  });

  test("handles non-function code gracefully", async () => {
    const res = await runUserCode(
      `"not a function"`,
      {},
      defaultOpts
    );
    expect(res.err).toContain("must evaluate to an async arrow function");
  });
});
