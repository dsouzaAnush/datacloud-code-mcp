import { describe, expect, test } from "vitest";
import {
  normalizeDataCloudCatalog,
  operationsFromOpenApiDocument
} from "../src/schema/catalog.js";
import { processSpec, resolveRefs, extractTags } from "../src/schema/spec-processor.js";

describe("catalog", () => {
  test("extracts operations from Data Cloud style OpenAPI paths", () => {
    const operations = operationsFromOpenApiDocument({
      info: { title: "Data Cloud API", version: "v64.0" },
      paths: {
        "/services/data/v64.0/ssot/query-sql": {
          post: {
            summary: "Create SQL Query",
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", required: ["sql"], properties: { sql: { type: "string" } } }
                }
              }
            }
          }
        },
        "/services/data/v64.0/ssot/query-sql/{queryId}/rows": {
          get: {
            summary: "Get SQL Query Rows",
            parameters: [{ name: "offset", in: "query", schema: { type: "integer" } }]
          }
        }
      }
    });

    const ids = operations.map((o) => o.operationId);
    expect(ids).toContain("POST /services/data/v64.0/ssot/query-sql");
    expect(ids).toContain("GET /services/data/v64.0/ssot/query-sql/{queryId}/rows");
  });

  test("normalizes duplicate operation ids", () => {
    const operations = operationsFromOpenApiDocument({
      info: { title: "Data Cloud API", version: "v64.0" },
      paths: {
        "/api/v1/metadata/": { get: { summary: "Get metadata", description: "First" } },
        "/api/v1/metadata": { get: { summary: "Get metadata duplicate", description: "Second" } }
      }
    });

    const normalized = normalizeDataCloudCatalog({ operations, rootSchema: { definitions: {} } });
    expect(normalized.operations.length).toBeGreaterThanOrEqual(1);
  });
});

describe("spec-processor", () => {
  test("resolves $ref pointers inline", () => {
    const root = {
      paths: {
        "/test": {
          get: {
            requestBody: { $ref: "#/components/requestBodies/TestBody" }
          }
        }
      },
      components: {
        requestBodies: {
          TestBody: { content: { "application/json": { schema: { type: "object" } } } }
        }
      }
    };

    const result = resolveRefs(root.paths["/test"]!.get.requestBody, root);
    expect(result).toEqual({ content: { "application/json": { schema: { type: "object" } } } });
  });

  test("handles circular $refs", () => {
    const root = {
      components: {
        schemas: {
          Node: { type: "object", properties: { child: { $ref: "#/components/schemas/Node" } } }
        }
      }
    };

    // Resolves one level deep; the second level hits the cycle.
    const result = resolveRefs(root.components.schemas.Node, root) as Record<string, unknown>;
    const props = result.properties as Record<string, Record<string, unknown>>;
    const innerChild = props.child;
    expect(innerChild.type).toBe("object");
    const innerProps = innerChild.properties as Record<string, { $circular?: string }>;
    expect(innerProps.child.$circular).toBe("#/components/schemas/Node");
  });

  test("processSpec produces resolved paths object", () => {
    const doc = {
      info: { title: "Test", version: "1" },
      tags: [{ name: "foo" }],
      paths: {
        "/a": { get: { summary: "A", tags: ["foo"] } },
        "/b": { post: { summary: "B" } }
      }
    };
    const spec = processSpec(doc);
    expect(Object.keys(spec.paths)).toHaveLength(2);
    expect(spec.paths["/a"]?.get?.summary).toBe("A");
  });

  test("extractTags collects unique tags", () => {
    const spec = processSpec({
      paths: {
        "/x": { get: { tags: ["alpha", "beta"] } },
        "/y": { post: { tags: ["beta", "gamma"] } }
      }
    });
    expect(extractTags(spec)).toEqual(["alpha", "beta", "gamma"]);
  });
});
