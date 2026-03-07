import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TaskFlowClient } from "../client.js";
import { formatSearchResults } from "../format.js";

export function registerSearchTools(server: McpServer, client: TaskFlowClient) {
  server.tool(
    "search_tasks",
    "Search for tasks by title or description across a workspace",
    {
      workspaceId: z.string().describe("The workspace ID to search in"),
      query: z
        .string()
        .min(2)
        .describe("Search query (minimum 2 characters)"),
    },
    async ({ workspaceId, query }) => {
      const data = await client.searchTasks(workspaceId, query);
      return {
        content: [{ type: "text", text: formatSearchResults(data) }],
      };
    }
  );
}
