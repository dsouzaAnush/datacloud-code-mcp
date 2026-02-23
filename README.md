# Data Cloud Code MCP

A standalone MCP server for Salesforce Data Cloud (Data360) that follows a Code Mode shape: `search` + `execute` + `auth_status`.

This implementation is inspired by the Cloudflare Code Mode MCP pattern and Anthropic's advanced tool-calling guidance:
- [Cloudflare Code Mode MCP](https://blog.cloudflare.com/code-mode-mcp/)
- [Cloudflare MCP repo](https://github.com/cloudflare/mcp)
- [Anthropic: Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)

## Why This Is Useful

Instead of exposing dozens of endpoint-level tools, this server gives agents a stable two-step loop:

1. `search` maps natural language intent to a valid Data Cloud operation.
2. `execute` validates and runs that exact operation.

This keeps context small, improves tool selection reliability, and centralizes validation/safety on the server.

## Why Better Than Salesforce Official MCP for Data Cloud Workflows

Official Salesforce MCP (`salesforcecli/mcp`) is a strong general Salesforce MCP, but this server is better for Data Cloud/Data360 agent tasks.

- Data Cloud focus: this repo ingests Data Cloud OpenAPI and docs context directly, then exposes Data Cloud operations as searchable `operation_id`s.
- Smaller tool surface: fixed `search` + `execute` + `auth_status` interface vs broad toolset surfaces.
- Better planning loop for agents: agents do intent resolution once (`search`) and execute one deterministic contract (`execute`).
- Built-in mutation safety: writes require `ALLOW_WRITES=true` and `confirm_write_token` replay from `dry_run`.
- Context/token controls: catalog cache, read-cache, and response truncation are enabled by default.

Reference for official MCP toolset shape:
- [salesforcecli/mcp](https://github.com/salesforcecli/mcp) (README documents `--toolsets`, `--dynamic-tools`, and warns that `all` can expose 60+ tools and overwhelm context)

## Comparison With CData Data Cloud MCP

- CData's open-source server is explicitly read-only in its README and repo description.
- This server supports both reads and writes with explicit guardrails (`ALLOW_WRITES`, `dry_run`, `confirm_write_token`).
- This server is OpenAPI-driven for Data Cloud endpoints and tuned for agent workflow (`search` -> `execute`) rather than SQL/JDBC abstraction.

Reference:
- [CData Salesforce Data Cloud MCP server](https://github.com/CDataSoftware/salesforce-data-cloud-mcp-server-by-cdata)

## Reference Alignment

- Cloudflare Code Mode pattern: fixed low-context tool surface instead of endpoint-per-tool explosion.
- Anthropic advanced tool use pattern: separation of discovery (`search`) and execution (`execute`) mirrors Tool Search + Programmatic execution ideas while keeping deterministic request contracts.
- Salesforce MCP strategy: aligns with Salesforce's published MCP direction across local/server-hosted ecosystems and Agentforce governance.

Reference:
- [Salesforce blog (June 2025): Introducing MCP support across Salesforce](https://developer.salesforce.com/blogs/2025/06/introducing-mcp-support-across-salesforce)

## Features

- Streamable HTTP MCP endpoint at `/mcp`
- OpenAPI-driven operation catalog from Data Cloud schema
- Lexical ranking search index with docs context
- Typed preflight validation (path/query/body)
- OAuth auth support with Salesforce -> Data Cloud token exchange
- Read/write guardrails (`dry_run`, confirmation token, server write gate)
- Persistent catalog cache + short TTL read cache
- Output truncation to bound context/token usage

## Tools

| Tool | Description |
| --- | --- |
| `search` | Returns ranked Data Cloud API operations for a natural-language query |
| `execute` | Validates input and executes a chosen `operation_id` |
| `auth_status` | Returns current caller auth state and scope metadata |

## Quick Start

```bash
cd /Users/anush.dsouza/startup/Aura12/work/codemode/datacloud
npm install
npm run build
npm test
```

## Auth Options

### Option 1 (Recommended): OAuth flow

1. Set OAuth env vars in `.env` (see `.env.example`).
2. Start server.
3. Open `/oauth/start?user_id=default`.
4. Complete login + consent.

### Option 2: Seed token from local CLI/env

This script supports both direct Data Cloud token seeding and Salesforce token exchange.

```bash
npm run seed:token
```

Common inputs:
- `DATACLOUD_ACCESS_TOKEN` + `DATACLOUD_INSTANCE_URL`
- or Salesforce CLI authenticated org (`sf org display --verbose`)
- or `SALESFORCE_ACCESS_TOKEN` + `SALESFORCE_INSTANCE_URL`

## Run Server

```bash
TOKEN_STORE_PATH=./data/tokens.integration.json \
TOKEN_ENCRYPTION_KEY_BASE64='<seed-output-key>' \
PORT=3000 HOST=127.0.0.1 npm run dev
```

Health check:

```bash
curl -sS http://127.0.0.1:3000/healthz
```

## Smoke Test

```bash
MCP_URL=http://127.0.0.1:3000/mcp USER_ID=default npm run smoke:mcp
```

Expected smoke output includes:
- tools: `search`, `execute`, `auth_status`
- `search` results for Data Cloud paths like `/services/data/v64.0/ssot/query-sql`

## MCP Client Integration

### Direct remote MCP

```json
{
  "mcpServers": {
    "datacloud-code-mcp": {
      "transport": "streamable_http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "x-user-id": "default"
      }
    }
  }
}
```

### Command bridge (if client requires command transport)

```json
{
  "mcpServers": {
    "datacloud-code-mcp": {
      "command": "npx",
      "args": ["mcp-remote", "http://127.0.0.1:3000/mcp"],
      "env": {
        "MCP_REMOTE_HEADERS": "{\"x-user-id\":\"default\"}"
      }
    }
  }
}
```

## Example Calls

Search:

```json
{
  "query": "run sql query",
  "limit": 5
}
```

Read execute:

```json
{
  "operation_id": "GET /services/data/v64.0/ssot/query-sql/{queryId}",
  "path_params": {
    "queryId": "0Xx000000000001AAA"
  }
}
```

Write dry run:

```json
{
  "operation_id": "POST /services/data/v64.0/ssot/segments",
  "body": {
    "name": "High Value Customers",
    "description": "Generated by MCP"
  },
  "dry_run": true
}
```

## Safety Model

- Mutating methods (`POST`, `PATCH`, `PUT`, `DELETE`) are blocked by default.
- Mutations require:
  - `ALLOW_WRITES=true`
  - a valid `confirm_write_token` from matching dry-run request
- Sensitive headers/body keys are redacted in tool output.

## Performance Model

- Fixed 3-tool interface keeps tool-list context small.
- Catalog is persisted (`CATALOG_CACHE_PATH`) and reused at boot.
- OpenAPI refresh runs in background.
- Read calls can be cached (`READ_CACHE_TTL_MS`).
- Large responses are truncated (`EXECUTE_MAX_BODY_BYTES`, `EXECUTE_BODY_PREVIEW_CHARS`).

## Configuration

See `/Users/anush.dsouza/startup/Aura12/work/codemode/datacloud/.env.example`.

Key vars:
- `DATACLOUD_OPENAPI_PATH`
- `DATACLOUD_DOCS_PATH`
- `DATACLOUD_API_BASE_URL`
- `ALLOW_WRITES`
- `REQUEST_TIMEOUT_MS`
- `MAX_RETRIES`
- `READ_CACHE_TTL_MS`
- `CATALOG_CACHE_PATH`
- `TOKEN_STORE_PATH`
- `TOKEN_ENCRYPTION_KEY_BASE64`
- `SALESFORCE_OAUTH_*`
- `DATACLOUD_TOKEN_EXCHANGE_PATH`

## Project Layout

- Source: `/Users/anush.dsouza/startup/Aura12/work/codemode/datacloud/src`
- Tests: `/Users/anush.dsouza/startup/Aura12/work/codemode/datacloud/tests`
- Scripts: `/Users/anush.dsouza/startup/Aura12/work/codemode/datacloud/scripts`
- References: `/Users/anush.dsouza/startup/Aura12/work/codemode/datacloud/REFERENCES.md`
