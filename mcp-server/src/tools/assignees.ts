import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TaskFlowClient } from "../client.js";

export function registerAssigneeTools(
  server: McpServer,
  client: TaskFlowClient
) {
  server.tool(
    "assign_task",
    "Assign or unassign a user from a task. Use list_members to find user IDs.",
    {
      taskId: z.string().uuid().describe("The task ID"),
      userId: z.string().uuid().describe("The user ID to assign/unassign"),
      action: z
        .enum(["assign", "unassign"])
        .describe("Whether to assign or unassign the user"),
    },
    async ({ taskId, userId, action }) => {
      const data =
        action === "assign"
          ? await client.assignTask(taskId, userId)
          : await client.unassignTask(taskId, userId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
