import type {
  JsonSchema,
  NormalizedCatalog,
  PathParameter,
  PlatformOperation,
  QueryParameter
} from "../types.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

interface OpenApiSchemaObject {
  $ref?: string;
  allOf?: OpenApiSchemaObject[];
  oneOf?: OpenApiSchemaObject[];
  anyOf?: OpenApiSchemaObject[];
  required?: string[];
  properties?: Record<string, OpenApiSchemaObject>;
  [key: string]: unknown;
}

interface OpenApiParameterObject {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  schema?: OpenApiSchemaObject;
}

interface OpenApiRequestBodyObject {
  $ref?: string;
  required?: boolean;
  content?: Record<string, { schema?: OpenApiSchemaObject }>;
}

interface OpenApiOperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameterObject[];
  requestBody?: OpenApiRequestBodyObject;
}

interface OpenApiPathItemObject {
  parameters?: OpenApiParameterObject[];
  [method: string]: unknown;
}

interface OpenApiDocument {
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
  tags?: Array<{ name?: string; description?: string }>;
  paths?: Record<string, OpenApiPathItemObject>;
  components?: {
    schemas?: Record<string, OpenApiSchemaObject>;
    parameters?: Record<string, OpenApiParameterObject>;
    requestBodies?: Record<string, OpenApiRequestBodyObject>;
    [key: string]: unknown;
  };
}

function sanitizePath(path: string): string {
  return path
    .replace(/\?.*$/, "")
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")
    .replace(/\{\{+/g, "{")
    .replace(/\}\}+/g, "}");
}

function extractPathParams(pathTemplate: string): PathParameter[] {
  const matches = pathTemplate.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g);
  const params = new Set<string>();
  for (const match of matches) {
    if (match[1]) {
      params.add(match[1]);
    }
  }
  return Array.from(params).map((name) => ({ name }));
}

function parseComponentRef(ref: string): { group: string; name: string } | null {
  const match = /^#\/components\/([^/]+)\/([^/]+)$/.exec(ref);
  if (!match?.[1] || !match?.[2]) {
    return null;
  }

  return {
    group: match[1],
    name: match[2]
  };
}

function resolveParameter(
  doc: OpenApiDocument,
  param: OpenApiParameterObject | undefined
): OpenApiParameterObject | undefined {
  if (!param) {
    return undefined;
  }

  if (!param.$ref) {
    return param;
  }

  const parsed = parseComponentRef(param.$ref);
  if (!parsed || parsed.group !== "parameters") {
    return undefined;
  }

  return doc.components?.parameters?.[parsed.name];
}

function resolveRequestBody(
  doc: OpenApiDocument,
  requestBody: OpenApiRequestBodyObject | undefined
): OpenApiRequestBodyObject | undefined {
  if (!requestBody) {
    return undefined;
  }

  if (!requestBody.$ref) {
    return requestBody;
  }

  const parsed = parseComponentRef(requestBody.$ref);
  if (!parsed || parsed.group !== "requestBodies") {
    return undefined;
  }

  return doc.components?.requestBodies?.[parsed.name];
}

function resolveSchema(
  doc: OpenApiDocument,
  schema: OpenApiSchemaObject | undefined,
  seenRefs = new Set<string>()
): OpenApiSchemaObject | undefined {
  if (!schema) {
    return undefined;
  }

  if (!schema.$ref) {
    return schema;
  }

  if (seenRefs.has(schema.$ref)) {
    return undefined;
  }

  seenRefs.add(schema.$ref);

  const parsed = parseComponentRef(schema.$ref);
  if (!parsed || parsed.group !== "schemas") {
    return undefined;
  }

  const resolved = doc.components?.schemas?.[parsed.name];
  return resolveSchema(doc, resolved, seenRefs);
}

function collectRequiredBodyFields(
  doc: OpenApiDocument,
  schema: OpenApiSchemaObject | undefined
): string[] {
  const resolved = resolveSchema(doc, schema);
  if (!resolved) {
    return [];
  }

  const direct = Array.isArray(resolved.required)
    ? resolved.required.filter((name): name is string => typeof name === "string")
    : [];

  const allOfRequired = Array.isArray(resolved.allOf)
    ? resolved.allOf.flatMap((nested) => collectRequiredBodyFields(doc, nested))
    : [];

  return Array.from(new Set([...direct, ...allOfRequired]));
}

function firstJsonSchemaFromRequestBody(
  requestBody: OpenApiRequestBodyObject | undefined
): OpenApiSchemaObject | undefined {
  const content = requestBody?.content;
  if (!content) {
    return undefined;
  }

  if (content["application/json"]?.schema) {
    return content["application/json"].schema;
  }

  for (const [contentType, descriptor] of Object.entries(content)) {
    if (contentType.includes("json") && descriptor?.schema) {
      return descriptor.schema;
    }
  }

  return undefined;
}

function mergeParameters(
  pathParameters: OpenApiParameterObject[] | undefined,
  operationParameters: OpenApiParameterObject[] | undefined,
  doc: OpenApiDocument
): OpenApiParameterObject[] {
  const merged = [...(pathParameters ?? []), ...(operationParameters ?? [])]
    .map((parameter) => resolveParameter(doc, parameter))
    .filter((parameter): parameter is OpenApiParameterObject => Boolean(parameter));

  const deduped = new Map<string, OpenApiParameterObject>();
  for (const parameter of merged) {
    const location = parameter.in ?? "unknown";
    const name = parameter.name ?? "unknown";
    deduped.set(`${location}:${name}`, parameter);
  }

  return Array.from(deduped.values());
}

function toQueryParams(parameters: OpenApiParameterObject[]): QueryParameter[] {
  return parameters
    .filter((parameter) => parameter.in === "query" && typeof parameter.name === "string")
    .map((parameter) => ({
      name: parameter.name as string,
      required: Boolean(parameter.required),
      schema: (parameter.schema as JsonSchema | undefined) ?? undefined
    }));
}

function createOperation(input: {
  method: string;
  path: string;
  source: string;
  doc: OpenApiDocument;
  operation: OpenApiOperationObject;
  pathItem: OpenApiPathItemObject;
}): PlatformOperation {
  const method = input.method.toUpperCase();
  const pathTemplate = sanitizePath(input.path);
  const pathParams = extractPathParams(pathTemplate);

  const mergedParameters = mergeParameters(
    input.pathItem.parameters,
    input.operation.parameters,
    input.doc
  );

  const queryParams = toQueryParams(mergedParameters);
  const requiredPathParams = pathParams.map((param) => param.name);
  const requiredQueryParams = queryParams
    .filter((param) => param.required)
    .map((param) => `query.${param.name}`);

  const requestBody = resolveRequestBody(input.doc, input.operation.requestBody);
  const requestSchema = firstJsonSchemaFromRequestBody(requestBody);
  const requiredBodyFields = collectRequiredBodyFields(input.doc, requestSchema).map(
    (field) => `body.${field}`
  );

  const requiredParams = Array.from(
    new Set([...requiredPathParams, ...requiredQueryParams, ...requiredBodyFields])
  );

  const title = input.operation.summary ?? `${method} ${pathTemplate}`;
  const description = input.operation.description ?? input.operation.summary ?? "";
  const tags = input.operation.tags ?? [];

  return {
    operationId: `${method} ${pathTemplate}`,
    method,
    pathTemplate,
    rawHref: pathTemplate,
    title,
    description,
    source: input.source,
    pathParams,
    queryParams,
    requiredParams,
    isMutating: !["GET", "HEAD"].includes(method),
    requestSchema: requestSchema as JsonSchema | undefined,
    searchText: [
      input.operation.operationId,
      title,
      description,
      pathTemplate,
      method,
      tags.join(" "),
      requiredParams.join(" "),
      input.source
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
  };
}

export function operationsFromOpenApiDocument(doc: OpenApiDocument): PlatformOperation[] {
  const operations: PlatformOperation[] = [];
  const source = `${doc.info?.title ?? "Salesforce Data 360 API"}${doc.info?.version ? ` ${doc.info.version}` : ""}`;

  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as OpenApiOperationObject | undefined;
      if (!operation || typeof operation !== "object") {
        continue;
      }

      operations.push(
        createOperation({
          method,
          path,
          source,
          doc,
          operation,
          pathItem
        })
      );
    }
  }

  return operations;
}

export function docsContextFromOpenApiDocument(doc: OpenApiDocument): string {
  const parts: string[] = [];

  if (doc.info?.title) {
    parts.push(doc.info.title);
  }
  if (doc.info?.description) {
    parts.push(doc.info.description);
  }

  for (const tag of doc.tags ?? []) {
    if (tag.name) {
      parts.push(tag.name);
    }
    if (tag.description) {
      parts.push(tag.description);
    }
  }

  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 120_000);
}

export function normalizeDataCloudCatalog(params: {
  operations: PlatformOperation[];
  rootSchema: JsonSchema;
}): NormalizedCatalog {
  const deduped = new Map<string, PlatformOperation>();

  for (const operation of params.operations) {
    const existing = deduped.get(operation.operationId);
    if (!existing) {
      deduped.set(operation.operationId, operation);
      continue;
    }

    deduped.set(operation.operationId, {
      ...existing,
      source: [existing.source, operation.source].filter(Boolean).join(" + "),
      searchText: `${existing.searchText} ${operation.searchText}`
    });
  }

  return {
    operations: Array.from(deduped.values()),
    rootSchema: params.rootSchema
  };
}
