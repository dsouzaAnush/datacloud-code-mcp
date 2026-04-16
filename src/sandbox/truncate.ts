import { safeSerialize } from "../execute/redaction.js";

const CHARS_PER_TOKEN = 4;

export function truncateResponse(content: unknown, maxBytes: number): string {
  const text = typeof content === "string" ? content : (safeSerialize(content) ?? String(content));
  if (text.length <= maxBytes) return text;

  const truncated = text.slice(0, maxBytes);
  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN);

  return `${truncated}\n\n--- TRUNCATED ---\nResponse was ~${estimatedTokens.toLocaleString()} tokens. Narrow your query to reduce response size.`;
}
