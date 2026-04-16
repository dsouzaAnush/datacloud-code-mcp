import { describe, expect, test } from "vitest";
import { runUserCode } from "../src/sandbox/runner.js";
import type { ResolvedSpec } from "../src/schema/spec-processor.js";

const fixtureSpec: ResolvedSpec = {
  paths: {
    "/services/data/v64.0/ssot/query-sql": {
      post: {
        summary: "Create SQL Query",
        description: "Execute SQL query against Data Cloud data",
        tags: ["query"],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", required: ["sql"], properties: { sql: { type: "string" } } }
            }
          }
        }
      }
    },
    "/services/data/v64.0/ssot/data-streams": {
      get: {
        summary: "List Data Streams",
        description: "List configured data streams",
        tags: ["data-streams"]
      }
    },
    "/services/data/v64.0/ssot/segments": {
      get: { summary: "List segments", tags: ["segments"] },
      post: { summary: "Create segment", tags: ["segments"] }
    },
    "/services/data/v64.0/ssot/calculated-insights": {
      get: { summary: "List calculated insights", tags: ["calculated-insights"] },
      post: { summary: "Create calculated insight", tags: ["calculated-insights"] }
    }
  }
};

const opts = { timeoutMs: 5000 };

describe("search via code-mode", () => {
  test("finds endpoints by tag", async () => {
    const res = await runUserCode(
      `async () => {
        const results = [];
        for (const [path, methods] of Object.entries(spec.paths)) {
          for (const [method, op] of Object.entries(methods)) {
            if (op.tags?.some(t => t === 'segments')) {
              results.push({ method: method.toUpperCase(), path, summary: op.summary });
            }
          }
        }
        return results;
      }`,
      { spec: fixtureSpec },
      opts
    );
    expect(res.err).toBeUndefined();
    const results = res.result as unknown[];
    expect(results).toHaveLength(2);
  });

  test("drills into schema details", async () => {
    const res = await runUserCode(
      `async () => {
        const op = spec.paths['/services/data/v64.0/ssot/query-sql']?.post;
        return { summary: op?.summary, requestBody: op?.requestBody };
      }`,
      { spec: fixtureSpec },
      opts
    );
    expect(res.err).toBeUndefined();
    const out = res.result as { summary: string; requestBody: unknown };
    expect(out.summary).toBe("Create SQL Query");
    expect(out.requestBody).toBeTruthy();
  });

  test("counts all endpoints", async () => {
    const res = await runUserCode(
      `async () => {
        let count = 0;
        for (const methods of Object.values(spec.paths)) {
          count += Object.keys(methods).length;
        }
        return count;
      }`,
      { spec: fixtureSpec },
      opts
    );
    expect(res.result).toBe(6);
  });
});
