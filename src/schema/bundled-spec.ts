import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// When running via tsx (dev) we resolve against src/schema; when compiled, against dist/schema.
// In both cases the YAML lives next to this file via the build copy step.
function candidatePaths(filename: string): string[] {
  return [
    join(here, filename),
    join(here, "..", "..", "src", "schema", filename),
    join(here, "..", "..", "..", "src", "schema", filename)
  ];
}

export function bundledSpecPath(): string | null {
  for (const candidate of candidatePaths("data360-api.bundled.yaml")) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function bundledExtrasPath(): string | null {
  for (const candidate of candidatePaths("d360-extras.yaml")) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
