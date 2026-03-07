import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TaskFlowClient } from "./client.js";
import { registerTools } from "./tools/index.js";

try {
  const server = new McpServer({
    name: "taskflow",
    version: "1.0.0",
  });

  const client = new TaskFlowClient();
  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (err) {
  console.error("TaskFlow MCP server failed to start:", err);
  process.exit(1);
}
