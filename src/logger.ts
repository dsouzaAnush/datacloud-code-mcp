import pino from "pino";
import type { AppConfig } from "./config.js";

export function createLogger(config: AppConfig) {
  return pino({
    name: "datacloud-code-mode-mcp",
    level: config.logLevel
  });
}
