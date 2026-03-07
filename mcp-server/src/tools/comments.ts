import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TaskFlowClient } from "../client.js";

export function registerCommentTools(
  server: McpServer,
  client: TaskFlowClient
) {
  server.tool(
    "add_comment",
    "Add a comment to a task",
    {
      taskId: z.string().uuid().describe("The task ID to comment on"),
      content: z.string().min(1).describe("The comment text"),
    },
    async ({ taskId, content }) => {
      const data = await client.addComment(taskId, content);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
