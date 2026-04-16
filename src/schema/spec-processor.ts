// Adapted from Cloudflare's MCP server (src/spec-processor.ts).
// Resolves OpenAPI $ref pointers inline so the search sandbox sees a flat object.

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

type Json = unknown;
type Dict = Record<string, Json>;

function isPlainObject(value: Json): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveRefs(node: Json, root: Dict, seen = new Set<string>()): Json {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map((item) => resolveRefs(item, root, seen));
  if (!isPlainObject(node)) return node;

  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    if (seen.has(ref)) return { $circular: ref };

    const parts = ref.replace(/^#\//, "").split("/");
    let target: Json = root;
    for (const part of parts) {
      if (!isPlainObject(target)) {
        target = undefined;
        break;
      }
      target = target[decodeURIComponent(part)];
    }
    if (target === undefined) return { $unresolved: ref };

    seen.add(ref);
    const resolved = resolveRefs(target, root, seen);
    seen.delete(ref);
    return resolved;
  }

  const out: Dict = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = resolveRefs(v, root, seen);
  }
  return out;
}

export interface ResolvedSpec {
  info?: { title?: string; version?: string; description?: string };
  paths: Record<string, Record<string, ResolvedOperation>>;
  tags?: Array<{ name?: string; description?: string }>;
}

export interface ResolvedOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown;
  requestBody?: unknown;
  responses?: unknown;
}

export function processSpec(rawSpec: Dict): ResolvedSpec {
  const rawPaths = (rawSpec.paths ?? {}) as Record<string, Dict>;
  const paths: ResolvedSpec["paths"] = {};

  for (const [path, pathItem] of Object.entries(rawPaths)) {
    if (!isPlainObject(pathItem)) continue;
    const methods: Record<string, ResolvedOperation> = {};

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!isPlainObject(op)) continue;
      methods[method] = {
        summary: op.summary as string | undefined,
        description: op.description as string | undefined,
        tags: Array.isArray(op.tags) ? (op.tags as string[]) : undefined,
        parameters: resolveRefs(op.parameters, rawSpec),
        requestBody: resolveRefs(op.requestBody, rawSpec),
        responses: resolveRefs(op.responses, rawSpec)
      };
    }

    if (Object.keys(methods).length > 0) {
      paths[path] = methods;
    }
  }

  return {
    info: rawSpec.info as ResolvedSpec["info"],
    tags: rawSpec.tags as ResolvedSpec["tags"],
    paths
  };
}

export function extractTags(spec: ResolvedSpec): string[] {
  const tags = new Set<string>();
  for (const methods of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(methods)) {
      for (const tag of op.tags ?? []) tags.add(tag);
    }
  }
  return Array.from(tags).sort();
}

export function deepMerge(target: Dict, source: Dict): Dict {
  const out: Dict = { ...target };
  for (const [k, v] of Object.entries(source)) {
    const existing = out[k];
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMerge(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
