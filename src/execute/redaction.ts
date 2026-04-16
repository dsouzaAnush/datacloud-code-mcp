const SENSITIVE_HEADER_PATTERN = /authorization|cookie|set-cookie|x-api-key/i;
const SENSITIVE_BODY_KEY_PATTERN = /(token|authorization|password|secret)/i;

export function redactBody(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactBody(item));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_BODY_KEY_PATTERN.test(key)) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = redactBody(item);
      }
    }
    return output;
  }

  return value;
}

export function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!SENSITIVE_HEADER_PATTERN.test(key)) {
      out[key] = value;
    }
  });
  return out;
}

export function safeSerialize(value: unknown): string | undefined {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
