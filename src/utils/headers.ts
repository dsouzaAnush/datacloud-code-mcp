export function getHeaderValue(
  headers: unknown,
  headerName: string
): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (typeof headers === "object" && headers !== null) {
    const asRecord = headers as Record<string, unknown> & {
      get?: (name: string) => string | null;
    };

    if (typeof asRecord.get === "function") {
      const value = asRecord.get(headerName);
      return value ?? undefined;
    }

    const direct = asRecord[headerName];
    if (typeof direct === "string") {
      return direct;
    }

    const lower = asRecord[headerName.toLowerCase()];
    if (typeof lower === "string") {
      return lower;
    }
  }

  return undefined;
}
