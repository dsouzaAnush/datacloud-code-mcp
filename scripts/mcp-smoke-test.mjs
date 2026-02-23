#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const serverUrl = process.env.MCP_URL || "http://127.0.0.1:3000/mcp";
const userId = process.env.USER_ID || "default";

const client = new Client({
  name: "datacloud-mcp-smoke-test",
  version: "0.1.0"
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

  const tools = await client.listTools();
  const auth = await client.callTool({ name: "auth_status", arguments: {} });
  const search = await client.callTool({
    name: "search",
    arguments: { query: "data cloud sql query", limit: 5 }
  });

  let readExecute = null;
  let executeError = null;
  const authText = extractText(auth);
  let authenticated = false;
  try {
    authenticated = Boolean(authText && JSON.parse(authText).authenticated);
  } catch {
    authenticated = false;
  }

  if (authenticated) {
    try {
      readExecute = await client.callTool({
        name: "execute",
        arguments: {
          operation_id: "GET /api/v1/metadata/"
        }
      });
    } catch (error) {
      executeError = String(error);
    }
  }

  console.log(
    JSON.stringify(
      {
        server_url: serverUrl,
        user_id: userId,
        tools: tools.tools.map((tool) => tool.name).sort(),
        auth_status: authText,
        search_result: extractText(search),
        execute_is_error: readExecute ? Boolean(readExecute.isError) : null,
        execute_excerpt: readExecute ? extractText(readExecute)?.slice(0, 1000) : null,
        execute_error: executeError
      },
      null,
      2
    )
  );
} finally {
  await client.close().catch(() => {});
  await transport.terminateSession().catch(() => {});
}
