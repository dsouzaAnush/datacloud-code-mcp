import { describe, expect, test } from "vitest";
import {
  normalizeDataCloudCatalog,
  operationsFromOpenApiDocument
} from "../src/schema/catalog.js";

describe("catalog", () => {
  test("extracts operations from Data Cloud style OpenAPI paths", () => {
    const operations = operationsFromOpenApiDocument({
      info: {
        title: "Data Cloud API",
        version: "v64.0"
      },
      paths: {
        "/services/data/v64.0/ssot/query-sql": {
          post: {
            summary: "Create SQL Query",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["sql"],
                    properties: {
                      sql: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        },
        "/services/data/v64.0/ssot/query-sql/{queryId}/rows": {
          get: {
            summary: "Get SQL Query Rows",
            parameters: [
              {
                name: "offset",
                in: "query",
                schema: { type: "integer" }
              }
            ]
          }
        }
      }
    });

    const ids = operations.map((operation) => operation.operationId);
    expect(ids).toContain("POST /services/data/v64.0/ssot/query-sql");
    expect(ids).toContain("GET /services/data/v64.0/ssot/query-sql/{queryId}/rows");

    const queryCreate = operations.find(
      (operation) => operation.operationId === "POST /services/data/v64.0/ssot/query-sql"
    );
    expect(queryCreate?.requiredParams).toContain("body.sql");

    const queryRows = operations.find(
      (operation) =>
        operation.operationId === "GET /services/data/v64.0/ssot/query-sql/{queryId}/rows"
    );
    expect(queryRows?.requiredParams).toContain("queryId");
  });

  test("normalizes duplicate operation ids", () => {
    const operations = operationsFromOpenApiDocument({
      info: {
        title: "Data Cloud API",
        version: "v64.0"
      },
      paths: {
        "/api/v1/metadata/": {
          get: {
            summary: "Get metadata",
            description: "First"
          }
        },
        "/api/v1/metadata": {
          get: {
            summary: "Get metadata duplicate",
            description: "Second"
          }
        }
      }
    });

    const normalized = normalizeDataCloudCatalog({
      operations,
      rootSchema: { definitions: {} }
    });

    expect(normalized.operations.length).toBeGreaterThanOrEqual(1);
    expect(
      normalized.operations.some((operation) =>
        operation.operationId === "GET /api/v1/metadata/" || operation.operationId === "GET /api/v1/metadata"
      )
    ).toBe(true);
  });
});
