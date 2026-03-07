import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TaskFlowClient } from "../client.js";
import { formatTasks, formatTask } from "../format.js";

export function registerTaskTools(server: McpServer, client: TaskFlowClient) {
  server.tool(
    "get_tasks",
    "Get all tasks in a list",
    { listId: z.string().describe("The list ID") },
    async ({ listId }) => {
      const data = await client.getTasks(listId);
      return {
        content: [{ type: "text", text: formatTasks(data) }],
      };
    }
  );

  server.tool(
    "get_task",
    "Get full details for a single task, including comments, assignees, and activity",
    { taskId: z.string().uuid().describe("The task ID") },
    async ({ taskId }) => {
      const data = await client.getTask(taskId);
      return {
        content: [{ type: "text", text: formatTask(data) }],
      };
    }
  );

  server.tool(
    "create_task",
    "Create a new task in a list",
    {
      listId: z.string().describe("The list ID to create the task in"),
      title: z.string().describe("Task title"),
      description: z
        .string()
        .optional()
        .describe("Task description (plain text)"),
      status: z.string().optional().describe("Task status (e.g. todo, in_progress, done)"),
      priority: z
        .enum(["urgent", "high", "medium", "low", "none"])
        .optional()
        .describe("Task priority"),
      dueDate: z
        .string()
        .optional()
        .describe("Due date in ISO 8601 format (e.g. 2025-12-31T00:00:00.000Z)"),
    },
    async ({ listId, title, description, status, priority, dueDate }) => {
      const data = await client.createTask(listId, {
        title,
        description,
        status,
        priority,
        dueDate,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "update_task",
    "Update an existing task's fields (title, status, priority, description, due date, or move to a different list)",
    {
      taskId: z.string().uuid().describe("The task ID to update"),
      title: z.string().optional().describe("New title"),
      status: z.string().optional().describe("New status (e.g. todo, in_progress, done)"),
      priority: z
        .enum(["urgent", "high", "medium", "low", "none"])
        .optional()
        .describe("New priority"),
      description: z
        .string()
        .optional()
        .describe("New description (plain text)"),
      dueDate: z
        .string()
        .nullable()
        .optional()
        .describe("New due date in ISO 8601 format, or null to clear"),
      listId: z
        .string()
        .optional()
        .describe("Move task to a different list by providing the target list ID"),
    },
    async ({ taskId, title, status, priority, description, dueDate, listId }) => {
      const data = await client.updateTask(taskId, {
        title,
        status,
        priority,
        description,
        dueDate,
        listId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
