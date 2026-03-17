import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TaskFlowClient } from "../client.js";
import { registerWorkspaceTools } from "./workspaces.js";
import { registerTaskTools } from "./tasks.js";
import { registerSearchTools } from "./search.js";
import { registerCommentTools } from "./comments.js";
import { registerAssigneeTools } from "./assignees.js";
import { registerDocumentTools } from "./documents.js";

export function registerTools(server: McpServer, client: TaskFlowClient) {
  registerWorkspaceTools(server, client);
  registerTaskTools(server, client);
  registerSearchTools(server, client);
  registerCommentTools(server, client);
  registerAssigneeTools(server, client);
  registerDocumentTools(server, client);
}
