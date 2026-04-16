#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const serverUrl = process.env.MCP_URL || "http://127.0.0.1:3000/mcp";
const userId = process.env.USER_ID || "default";

const client = new Client({
  name: "datacloud-mcp-smoke-test",
  version: "0.2.0"
});

const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
  requestInit: {
    headers: {
      "x-user-id": userId
    }
  }
});

function extractText(result) {
  return result?.content?.[0]?.type === "text" ? result.content[0].text : null;
}

try {
  await client.connect(transport);

  // 1. List tools
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  console.log("tools:", toolNames);

  // 2. Auth status
  const auth = await client.callTool({ name: "auth_status", arguments: {} });
  console.log("auth_status:", extractText(auth)?.slice(0, 200));

  // 3. Search — find segment endpoints by tag
  const searchResult = await client.callTool({
    name: "search",
    arguments: {
      code: `async () => {
        const results = [];
        for (const [path, methods] of Object.entries(spec.paths)) {
          for (const [method, op] of Object.entries(methods)) {
            if (op.tags?.some(t => t.toLowerCase().includes('segment'))) {
              results.push({ method: method.toUpperCase(), path, summary: op.summary });
            }
          }
        }
        return results;
      }`
    }
  });
  console.log("search (segments):", extractText(searchResult)?.slice(0, 500));

  // 4. Search — count total endpoints
  const countResult = await client.callTool({
    name: "search",
    arguments: {
      code: `async () => {
        let count = 0;
        for (const methods of Object.values(spec.paths)) {
          count += Object.keys(methods).length;
        }
        return { total_operations: count };
      }`
    }
  });
  console.log("search (count):", extractText(countResult));

  // 5. Search — inspect a specific endpoint
  const inspectResult = await client.callTool({
    name: "search",
    arguments: {
      code: `async () => {
        const op = spec.paths['/services/data/v64.0/ssot/query-sql']?.post;
        return { summary: op?.summary, tags: op?.tags };
      }`
    }
  });
  console.log("search (inspect):", extractText(inspectResult));

  // 6. Execute — only if authenticated
  let authenticated = false;
  try {
    const authText = extractText(auth);
    authenticated = Boolean(authText && JSON.parse(authText).authenticated);
  } catch {
    authenticated = false;
  }

  if (authenticated) {
    const execResult = await client.callTool({
      name: "execute",
      arguments: {
        code: `async () => {
          return await salesforce.request({
            method: "GET",
            path: "/services/data/v64.0/ssot/data-streams"
          });
        }`
      }
    });
    console.log("execute (data-streams):", extractText(execResult)?.slice(0, 500));
  } else {
    console.log("execute: skipped (not authenticated)");
  }

  console.log("\nSmoke test complete.");
} finally {
  await client.close().catch(() => {});
  await transport.terminateSession().catch(() => {});
}
