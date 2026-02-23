import { createHmac } from "node:crypto";

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);

  return `{${entries.join(",")}}`;
}

export function createWriteConfirmationToken(input: {
  secret: string;
  userId: string;
  operationId: string;
  pathParams: Record<string, string>;
  queryParams: Record<string, string | number | boolean>;
  body: unknown;
}): string {
  const payload = [
    input.userId,
    input.operationId,
    stableStringify(input.pathParams),
    stableStringify(input.queryParams),
    stableStringify(input.body)
  ].join("|");

  return createHmac("sha256", input.secret)
    .update(payload)
    .digest("base64url")
    .slice(0, 48);
}
