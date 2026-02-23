import type { PlatformOperation, SearchResponse, SearchResultItem } from "../types.js";

export interface SearchOptions {
  query: string;
  limit?: number;
  resourceFilter?: string[];
}

interface IndexedOperation {
  operation: PlatformOperation;
  termFrequency: Map<string, number>;
  maxTermFrequency: number;
  haystack: string;
}

const TOKEN_SPLIT = /[^a-z0-9_]+/;

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function countTerms(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

export class SearchIndex {
  private indexed: IndexedOperation[] = [];

  private inverseDocumentFrequency = new Map<string, number>();

  private docsContext = "";

  setOperations(operations: PlatformOperation[], docsContext: string): void {
    this.docsContext = docsContext.toLowerCase();
    this.indexed = operations.map((operation) => {
      const tokens = tokenize(
        [
          operation.operationId,
          operation.title ?? "",
          operation.description ?? "",
          operation.searchText,
          operation.pathTemplate,
          operation.method,
          operation.source ?? ""
        ].join(" ")
      );

      const termFrequency = countTerms(tokens);
      let maxTermFrequency = 1;
      for (const value of termFrequency.values()) {
        if (value > maxTermFrequency) {
          maxTermFrequency = value;
        }
      }

      return {
        operation,
        termFrequency,
        maxTermFrequency,
        haystack: [
          operation.operationId,
          operation.pathTemplate,
          operation.title ?? "",
          operation.description ?? "",
          operation.rel ?? "",
          operation.source ?? ""
        ]
          .join(" ")
          .toLowerCase()
      };
    });

    const docCount = Math.max(this.indexed.length, 1);
    const documentFrequency = new Map<string, number>();

    for (const row of this.indexed) {
      for (const term of row.termFrequency.keys()) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }

    this.inverseDocumentFrequency.clear();
    for (const [term, frequency] of documentFrequency.entries()) {
      const idf = Math.log((1 + docCount) / (1 + frequency)) + 1;
      this.inverseDocumentFrequency.set(term, idf);
    }
  }

  search(options: SearchOptions): SearchResponse {
    const query = options.query.trim();
    const limit = Math.max(1, Math.min(options.limit ?? 8, 25));
    const filters = new Set((options.resourceFilter ?? []).map((f) => f.toLowerCase()));

    if (!query) {
      return { results: [] };
    }

    const queryTokens = tokenize(query);
    const queryLower = query.toLowerCase();

    const scored = this.indexed
      .filter(({ operation }) => {
        if (filters.size === 0) {
          return true;
        }

        const matchSet = [
          operation.source ?? "",
          operation.pathTemplate,
          operation.operationId,
          operation.title ?? "",
          operation.description ?? ""
        ]
          .join(" ")
          .toLowerCase();

        return Array.from(filters).some((filter) => matchSet.includes(filter));
      })
      .map(({ operation, termFrequency, maxTermFrequency, haystack }) => {
        let score = 0;

        for (const token of queryTokens) {
          const tf = termFrequency.get(token) ?? 0;
          if (tf > 0) {
            const idf = this.inverseDocumentFrequency.get(token) ?? 1;
            score += (tf / maxTermFrequency) * idf;
          }
        }

        if (haystack.includes(queryLower)) {
          score += 6;
        }
        if (operation.pathTemplate.includes(queryLower)) {
          score += 3;
        }
        if ((operation.title ?? "").toLowerCase().includes(queryLower)) {
          score += 2;
        }
        if (queryTokens.includes(operation.method.toLowerCase())) {
          score += 1;
        }

        if (this.docsContext && queryTokens.some((token) => this.docsContext.includes(token))) {
          score += 0.25;
        }

        const summary =
          operation.description ??
          operation.title ??
          `${operation.method} ${operation.pathTemplate}`;

        const result: SearchResultItem = {
          operation_id: operation.operationId,
          method: operation.method,
          path: operation.pathTemplate,
          summary,
          required_params: operation.requiredParams,
          is_mutating: operation.isMutating,
          score: Number(score.toFixed(4))
        };

        return result;
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return {
      results: scored
    };
  }
}
