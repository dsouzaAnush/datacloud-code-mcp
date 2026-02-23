import { describe, expect, test } from "vitest";
import { SearchIndex } from "../src/search/search-index.js";
import type { PlatformOperation } from "../src/types.js";

function makeOperation(input: Partial<PlatformOperation>): PlatformOperation {
  return {
    operationId: input.operationId ?? "GET /api/v1/metadata/",
    method: input.method ?? "GET",
    pathTemplate: input.pathTemplate ?? "/api/v1/metadata/",
    rawHref: input.rawHref ?? "/api/v1/metadata/",
    source: input.source ?? "Data Cloud",
    pathParams: input.pathParams ?? [],
    queryParams: input.queryParams ?? [],
    requiredParams: input.requiredParams ?? [],
    isMutating: input.isMutating ?? false,
    searchText: input.searchText ?? "",
    title: input.title,
    description: input.description,
    rel: input.rel,
    requestSchema: input.requestSchema,
    targetSchemaRef: input.targetSchemaRef
  };
}

describe("SearchIndex", () => {
  test("ranks SQL query operation for query intent", () => {
    const index = new SearchIndex();
    index.setOperations(
      [
        makeOperation({
          operationId: "POST /services/data/v64.0/ssot/query-sql",
          method: "POST",
          pathTemplate: "/services/data/v64.0/ssot/query-sql",
          title: "Create SQL Query",
          description: "Execute SQL query against Data Cloud data",
          searchText: "data cloud sql query"
        }),
        makeOperation({
          operationId: "GET /services/data/v64.0/ssot/data-streams",
          method: "GET",
          pathTemplate: "/services/data/v64.0/ssot/data-streams",
          title: "List Data Streams",
          description: "List configured data streams",
          searchText: "data streams list"
        })
      ],
      "Data Cloud API docs"
    );

    const result = index.search({ query: "run sql query", limit: 5 });
    expect(result.results[0]?.operation_id).toBe("POST /services/data/v64.0/ssot/query-sql");
  });

  test("returns ranked disambiguation for segment query", () => {
    const index = new SearchIndex();
    index.setOperations(
      [
        makeOperation({
          operationId: "GET /services/data/v64.0/ssot/segments",
          method: "GET",
          pathTemplate: "/services/data/v64.0/ssot/segments",
          title: "List segments",
          searchText: "segments list"
        }),
        makeOperation({
          operationId: "POST /services/data/v64.0/ssot/segments",
          method: "POST",
          pathTemplate: "/services/data/v64.0/ssot/segments",
          title: "Create segment",
          searchText: "segments create"
        })
      ],
      ""
    );

    const result = index.search({ query: "segments", limit: 5 });
    expect(result.results.length).toBeGreaterThanOrEqual(2);
    expect(result.results[0]?.score).toBeGreaterThanOrEqual(result.results[1]?.score ?? 0);
  });
});
