# Data Cloud Code MCP

A Salesforce Data Cloud (Data360) MCP server using the **Cloudflare Code Mode** pattern: two tools (`search` + `execute`), each taking a JavaScript async arrow function, with a fixed ~1k-token tool footprint regardless of API surface size.

## How It Works

Instead of exposing hundreds of endpoint-level tools, this server gives agents a stable two-step loop:

1. **`search`** — agent writes JavaScript to filter the OpenAPI spec and discover Data Cloud endpoints.
2. **`execute`** — agent writes JavaScript that calls `salesforce.request()` to make authenticated API requests.

Both tools run user code in a `node:vm` sandbox with restricted globals. The full OpenAPI spec never enters the model context — the agent explores it programmatically through `search()`.

## What's Covered

~185 Data Cloud operations across 25 API families:

| Family | Examples |
|--------|----------|
| **Query** | SQL query (v1/v2/v3), profile, insights, data graphs |
| **DMO/DLO** | CRUD for Data Model Objects and Data Lake Objects |
| **Mappings** | DMO field mappings, bulk mappings, standard mappings |
| **Data Streams** | List, create, update, delete, trigger runs |
| **Connectors** | List types, metadata, CRUD connections, test |
| **Calculated Insights** | CRUD, run, validate, enable/disable |
| **Segments** | CRUD, publish, members, overlap analysis |
| **Identity Resolution** | CRUD rulesets, publish, run, match history |
| **Activations** | CRUD activations + targets, sync, history |
| **Data Transforms** | CRUD, run, validate, schedule |
| **Semantic Data Models** | Models, objects, dimensions, measurements, metrics, relationships, query |
| **Data Spaces** | CRUD spaces, member management |
| **DataKits** | List, manifest, deploy, undeploy, component status |
| **GDPR** | Right-to-access, bulk read, erasure requests |
| **Search Indexes** | CRUD, hybrid full-text query |
| **Eventing** | Single and batch a360 event publish |
| **Data Actions** | CRUD actions + targets |

## Quick Start

```bash
npm install
npm run build
npm test        # 27 tests across 5 suites
```

## Auth Options

### Option 1: Direct access token (same env vars as d360-mcp-server)
```bash
CDP_ACCESS_TOKEN=<token> CDP_INSTANCE_URL=<url> npm run dev
```

### Option 2: OAuth client credentials
```bash
CDP_CLIENT_ID=<id> CDP_CLIENT_SECRET=<secret> CDP_LOGIN_URL=https://login.salesforce.com npm run dev
```

### Option 3: OAuth web flow
1. Set `SALESFORCE_OAUTH_CLIENT_ID`, `SALESFORCE_OAUTH_CLIENT_SECRET`, `SALESFORCE_OAUTH_REDIRECT_URI` in `.env`.
2. Start server: `npm run dev`
3. Open `/oauth/start?user_id=default` and complete login.

### Option 4: Seed token from CLI
```bash
npm run seed:token     # reads sf CLI auth or env vars
TOKEN_STORE_PATH=./data/tokens.integration.json \
TOKEN_ENCRYPTION_KEY_BASE64='<from seed>' npm run dev
```

## Run Server

```bash
PORT=3000 HOST=127.0.0.1 npm run dev
curl -sS http://127.0.0.1:3000/healthz
```

## Smoke Test

```bash
MCP_URL=http://127.0.0.1:3000/mcp USER_ID=default npm run smoke:mcp
```

## Example Calls

### Search: find endpoints by tag
```json
{
  "name": "search",
  "arguments": {
    "code": "async () => {\n  const results = [];\n  for (const [path, methods] of Object.entries(spec.paths)) {\n    for (const [method, op] of Object.entries(methods)) {\n      if (op.tags?.some(t => t.toLowerCase().includes('segment'))) {\n        results.push({ method: method.toUpperCase(), path, summary: op.summary });\n      }\n    }\n  }\n  return results;\n}"
  }
}
```

### Search: inspect an endpoint schema
```json
{
  "name": "search",
  "arguments": {
    "code": "async () => {\n  const op = spec.paths['/services/data/v64.0/ssot/query-sql']?.post;\n  return { summary: op?.summary, requestBody: op?.requestBody };\n}"
  }
}
```

### Execute: run a SQL query
```json
{
  "name": "execute",
  "arguments": {
    "code": "async () => {\n  return await salesforce.request({\n    method: 'POST',\n    path: '/services/data/v64.0/ssot/query-sql',\n    body: { sql: 'SELECT FirstName__c FROM UnifiedIndividual__dlm LIMIT 5' }\n  });\n}"
  }
}
```

### Execute: chain multiple calls
```json
{
  "name": "execute",
  "arguments": {
    "code": "async () => {\n  const list = await salesforce.request({ method: 'GET', path: '/services/data/v64.0/ssot/segments' });\n  const first = list.body?.data?.[0];\n  if (!first) return { message: 'No segments' };\n  return await salesforce.request({ method: 'GET', path: '/services/data/v64.0/ssot/segments/' + first.id });\n}"
  }
}
```

## MCP Client Integration

```json
{
  "mcpServers": {
    "datacloud-code-mcp": {
      "transport": "streamable_http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "x-user-id": "default" }
    }
  }
}
```

## Safety Model

- Mutating methods (`POST`, `PATCH`, `PUT`, `DELETE`) blocked unless `ALLOW_WRITES=true`.
- `salesforce.request()` only allows outbound HTTP to the authenticated instance's hostname + `*.salesforce.com` + `*.force.com`.
- Sensitive headers/body keys are redacted in tool output.
- User code runs in a `node:vm` sandbox with no `require`, `process`, `global`, or filesystem access.
- Sandbox enforces `SANDBOX_TIMEOUT_MS` (default 15s) to prevent runaway execution.

## Deploy to Heroku

```bash
heroku create
heroku config:set TOKEN_ENCRYPTION_KEY_BASE64=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
heroku config:set ALLOW_WRITES=false
heroku config:set CDP_ACCESS_TOKEN=<token> CDP_INSTANCE_URL=<url>
git push heroku main
```

Then point your MCP client at `https://<app>.herokuapp.com/mcp`.

## Configuration

See `.env.example` for all available environment variables.

## Project Layout

```
src/
  index.ts              HTTP server + MCP session management
  mcp-server.ts         Tool registration (search, execute, auth_status)
  config.ts             Zod-parsed environment config
  types.ts              Shared TypeScript interfaces
  logger.ts             Pino logger
  auth/
    oauth-service.ts    Salesforce OAuth web flow + token exchange
    auth-modes.ts       Strategy resolver (direct/client-cred/password/oauth)
    token-store.ts      AES-256-GCM encrypted token persistence
  schema/
    datacloud-schema-service.ts   Catalog loader, merger, $ref resolver
    catalog.ts                    OpenAPI → PlatformOperation parser
    spec-processor.ts             $ref resolution + spec processing (Cloudflare pattern)
    bundled-spec.ts               Resolve bundled YAML paths
    data360-api.bundled.yaml      Base OpenAPI spec (~35 endpoints)
    d360-extras.yaml              Extended endpoints (~150 more operations)
  sandbox/
    runner.ts           node:vm sandbox executor
    sf-client.ts        salesforce.request() injectable client
    safe-fetch.ts       Hostname-allow-listed fetch wrapper
    truncate.ts         Response truncation
  execute/
    datacloud-executor.ts   Legacy structured executor (kept for reference)
    redaction.ts            Body/header redaction helpers
    http-policy.ts          Retry + read-cache helpers
  safety/
    write-confirmation.ts   HMAC write tokens (used by legacy executor)
  search/
    search-index.ts         BM25 search index (kept for potential reuse)
  utils/
    crypto.ts               AES-256-GCM encrypt/decrypt
    headers.ts              Header value resolver
tests/                      Vitest test suites
scripts/                    Smoke test + token seed scripts
docs/                       Reference docs (Data Cloud guide, Postman)
```

## References

- [Cloudflare Code Mode MCP](https://blog.cloudflare.com/code-mode-mcp/) — the pattern this server follows
- [Cloudflare MCP repo](https://github.com/cloudflare/mcp) — reference implementation
- [Anthropic: Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
