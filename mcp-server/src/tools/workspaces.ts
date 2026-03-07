import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TaskFlowClient } from "../client.js";

export function registerWorkspaceTools(
  server: McpServer,
  client: TaskFlowClient
) {
  server.tool(
    "list_workspaces",
    "List all workspaces you belong to",
    {},
    async () => {
      const data = await client.listWorkspaces();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "list_lists",
    "Get all lists in a workspace, grouped by space and folder",
    { workspaceId: z.string().describe("The workspace ID") },
    async ({ workspaceId }) => {
      const data = await client.listLists(workspaceId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "list_members",
    "List all members of a workspace (useful for assigning tasks)",
    { workspaceId: z.string().describe("The workspace ID") },
    async ({ workspaceId }) => {
      const data = await client.listMembers(workspaceId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
