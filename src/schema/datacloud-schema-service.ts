import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import YAML from "yaml";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { JsonSchema, PlatformOperation } from "../types.js";
import {
  docsContextFromOpenApiDocument,
  normalizeDataCloudCatalog,
  operationsFromOpenApiDocument
} from "./catalog.js";

interface CatalogCachePayload {
  version: 1;
  cachedAt: string;
  openApiEtag?: string;
  openApiLastModified?: string;
  openApiFingerprint?: string;
  operations: PlatformOperation[];
  rootSchema: JsonSchema;
  docsContext: string;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stripMdx(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/\[[^\]]+\]\([^\)]+\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class DataCloudSchemaService {
  private operations: PlatformOperation[] = [];

  private operationById = new Map<string, PlatformOperation>();

  private rootSchema?: JsonSchema;

  private docsContext = "";

  private refreshInFlight?: Promise<void>;

  private cacheLoaded = false;

  private openApiEtag?: string;

  private openApiLastModified?: string;

  private openApiFingerprint?: string;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async bootstrapFromCache(): Promise<void> {
    if (this.cacheLoaded) {
      return;
    }
    this.cacheLoaded = true;

    try {
      const raw = await readFile(this.config.catalogCachePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<CatalogCachePayload>;

      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.operations) ||
        !parsed.rootSchema ||
        typeof parsed.docsContext !== "string"
      ) {
        this.logger.warn(
          { path: this.config.catalogCachePath },
          "Ignoring invalid Data Cloud catalog cache payload"
        );
        return;
      }

      this.operations = parsed.operations;
      this.rootSchema = parsed.rootSchema as JsonSchema;
      this.operationById = new Map(
        parsed.operations.map((operation) => [operation.operationId, operation])
      );
      this.docsContext = parsed.docsContext;
      this.openApiEtag = parsed.openApiEtag;
      this.openApiLastModified = parsed.openApiLastModified;
      this.openApiFingerprint = parsed.openApiFingerprint;

      this.logger.info(
        {
          path: this.config.catalogCachePath,
          operations: this.operations.length
        },
        "Loaded Data Cloud catalog cache"
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(
          { err: error, path: this.config.catalogCachePath },
          "Failed to load Data Cloud catalog cache"
        );
      }
    }
  }

  async ensureReady(): Promise<void> {
    await this.bootstrapFromCache();

    if (this.operations.length > 0) {
      return;
    }

    await this.refresh(true);
  }

  async refresh(force = false): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.refreshInternal(force);
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private async refreshInternal(force: boolean): Promise<void> {
    await this.bootstrapFromCache();

    const openApiRaw = await this.loadOpenApiSpec(force);
    if (!openApiRaw) {
      if (this.operations.length > 0) {
        this.logger.debug("Data Cloud OpenAPI unchanged; keeping cached catalog");
        return;
      }
      throw new Error("Unable to load Data Cloud OpenAPI and no cache exists");
    }

    const parsed = YAML.parse(openApiRaw) as Record<string, unknown>;
    const operations = operationsFromOpenApiDocument(parsed);
    const openApiDocsContext = docsContextFromOpenApiDocument(parsed);
    const localDocsContext = await this.loadDocsContextFromFilesystem();

    const normalized = normalizeDataCloudCatalog({
      operations,
      rootSchema: {
        ...(parsed as Record<string, unknown>),
        definitions: ((parsed.components as Record<string, unknown> | undefined)?.schemas ??
          {}) as Record<string, unknown>
      }
    });

    this.operations = normalized.operations;
    this.rootSchema = normalized.rootSchema;
    this.operationById = new Map(
      normalized.operations.map((operation) => [operation.operationId, operation])
    );
    this.docsContext = [openApiDocsContext, localDocsContext]
      .filter(Boolean)
      .join(" ")
      .slice(0, 120_000);

    this.logger.info(
      {
        operations: this.operations.length,
        openapi: this.config.dataCloudOpenApiPath
      },
      "Data Cloud operation catalog refreshed"
    );

    await this.persistCache();
  }

  private async loadOpenApiSpec(force: boolean): Promise<string | null> {
    const source = this.config.dataCloudOpenApiPath;

    if (isHttpUrl(source)) {
      return this.loadOpenApiFromUrl(source, force);
    }

    return this.loadOpenApiFromFile(source, force);
  }

  private async loadOpenApiFromUrl(url: string, force: boolean): Promise<string | null> {
    const headers: HeadersInit = {
      Accept: "application/yaml, text/yaml, application/json, text/plain"
    };

    if (!force && this.openApiEtag) {
      headers["If-None-Match"] = this.openApiEtag;
    }
    if (!force && !this.openApiEtag && this.openApiLastModified) {
      headers["If-Modified-Since"] = this.openApiLastModified;
    }

    try {
      const response = await this.fetchFn(url, {
        method: "GET",
        headers
      });

      if (response.status === 304) {
        return null;
      }

      if (!response.ok) {
        this.logger.warn({ url, status: response.status }, "Failed to fetch Data Cloud OpenAPI URL");
        return null;
      }

      const raw = await response.text();
      this.openApiEtag = response.headers.get("etag") ?? this.openApiEtag;
      this.openApiLastModified =
        response.headers.get("last-modified") ?? this.openApiLastModified;
      this.openApiFingerprint = sha256(raw);

      return raw;
    } catch (error) {
      this.logger.warn({ err: error, url }, "Failed to fetch Data Cloud OpenAPI URL");
      return null;
    }
  }

  private async loadOpenApiFromFile(filePath: string, force: boolean): Promise<string | null> {
    try {
      const metadata = await stat(filePath);
      const fingerprint = `${metadata.size}:${metadata.mtimeMs}`;

      if (!force && this.openApiFingerprint && this.openApiFingerprint === fingerprint) {
        return null;
      }

      const raw = await readFile(filePath, "utf8");
      this.openApiFingerprint = fingerprint;
      return raw;
    } catch (error) {
      this.logger.warn({ err: error, filePath }, "Failed to read Data Cloud OpenAPI file");
      return null;
    }
  }

  private async loadDocsContextFromFilesystem(): Promise<string> {
    const docsRoot = this.config.dataCloudDocsPath;
    const paths = [
      "getting-started/quickstart.mdx",
      "apis/query-api/query-services.mdx",
      "apis/query-api/profile-api.mdx",
      "apis/connect-api/data-ingestion.mdx",
      "apis/connect-api/data-streams.mdx",
      "apis/connect-api/segments.mdx",
      "apis/connect-api/activations.mdx",
      "apis/connect-api/identity-resolution.mdx"
    ];

    const chunks: string[] = [];
    for (const relativePath of paths) {
      const absolutePath = join(docsRoot, relativePath);
      try {
        const raw = await readFile(absolutePath, "utf8");
        chunks.push(stripMdx(raw));
      } catch {
        // Ignore missing docs files.
      }
    }

    return chunks.join(" ").slice(0, 80_000);
  }

  private async persistCache(): Promise<void> {
    if (!this.rootSchema) {
      return;
    }

    const payload: CatalogCachePayload = {
      version: 1,
      cachedAt: new Date().toISOString(),
      openApiEtag: this.openApiEtag,
      openApiLastModified: this.openApiLastModified,
      openApiFingerprint: this.openApiFingerprint,
      operations: this.operations,
      rootSchema: this.rootSchema,
      docsContext: this.docsContext
    };

    try {
      await mkdir(dirname(this.config.catalogCachePath), { recursive: true });
      await writeFile(this.config.catalogCachePath, JSON.stringify(payload), "utf8");
    } catch (error) {
      this.logger.warn(
        { err: error, path: this.config.catalogCachePath },
        "Failed to persist Data Cloud catalog cache"
      );
    }
  }

  getOperations(): PlatformOperation[] {
    return this.operations;
  }

  getOperation(operationId: string): PlatformOperation | undefined {
    return this.operationById.get(operationId);
  }

  getRootSchema(): JsonSchema | undefined {
    return this.rootSchema;
  }

  getDocsContext(): string {
    return this.docsContext;
  }
}
