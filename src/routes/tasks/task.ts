import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and, desc, asc, isNull } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";
import { runAutomations } from "../../lib/automations.js";
import { autoCreateDueDateReminder } from "../../lib/reminders.js";
import { createNotification, notifyMentions } from "../../lib/notifications.js";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { config } from "../../config.js";
import { randomUUID } from "crypto";

const {
  tasks, lists, spaces, workspaceMembers, taskActivities, taskAssignees,
  taskComments, users, taskLabels, labels, taskAttachments, timeEntries,
  reminders, sprintTasks, sprints,
} = schema;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Schemas ---
const updateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.record(z.string(), z.unknown()).optional(),
  status: z.string().max(50).optional(),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
  dueDate: z.string().datetime().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  timeEstimate: z.number().min(0).nullable().optional(),
  timeSpent: z.number().min(0).optional(),
  order: z.number().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  parentTaskId: z.string().uuid().nullable().optional(),
  listId: z.string().uuid().optional(),
});

const createCommentSchema = z.object({ content: z.string().min(1) });
const addAssigneeSchema = z.object({ userId: z.string().uuid() });
const addLabelSchema = z.object({ labelId: z.string().uuid() });
const createSubtaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.record(z.string(), z.unknown()).optional(),
  status: z.string().max(50).optional(),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
  dueDate: z.string().datetime().optional(),
  timeEstimate: z.number().min(0).optional(),
  order: z.number().optional(),
});
const createTimeEntrySchema = z.object({
  description: z.string().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  duration: z.number().min(0).optional(),
});
const createReminderSchema = z.object({
  remindAt: z.string().datetime(),
  type: z.enum(["notification", "email", "both"]).default("notification"),
  preset: z.enum(["15min", "1hour", "1day", "custom"]).optional(),
});
const linkDependencySchema = z.object({ blockedTaskId: z.string().uuid() });
const assignSprintSchema = z.object({ sprintId: z.string().uuid() });

// --- S3 Client ---
const s3Client = new S3Client({
  endpoint: config.s3Endpoint,
  region: config.s3Region,
  credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
  forcePathStyle: true,
});
const BUCKET = config.s3Bucket;
const ALLOWED_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
  "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/x-matroska",
  "application/pdf", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain", "text/csv", "application/zip",
];
const MAX_SIZE = 50 * 1024 * 1024;

// --- Helpers ---
async function checkTaskAccess(taskId: string, userId: string) {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    with: { list: { with: { space: true } } },
  });
  if (!task) return null;
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, task.list.space.workspaceId), eq(workspaceMembers.userId, userId)),
  });
  if (!membership) return null;
  return { task, membership };
}

function calculateRemindAt(preset: string, dueDate: Date | null): Date | null {
  if (!dueDate) return null;
  const base = new Date(dueDate);
  switch (preset) {
    case "15min": return new Date(base.getTime() - 15 * 60 * 1000);
    case "1hour": return new Date(base.getTime() - 60 * 60 * 1000);
    case "1day": return new Date(base.getTime() - 24 * 60 * 60 * 1000);
    default: return null;
  }
}

export default async function taskRoutes(fastify: FastifyInstance) {
  // ==================== TASK CRUD ====================

  // GET /tasks/:id
  fastify.get("/tasks/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    if (!UUID_REGEX.test(taskId)) return reply.status(400).send({ error: "Invalid task ID format" });
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });

      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
        with: {
          list: { columns: { id: true, name: true, spaceId: true }, with: { space: { columns: { id: true, name: true, workspaceId: true } } } },
          assignees: { with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } } },
          creator: { columns: { id: true, name: true, email: true, avatarUrl: true } },
          comments: { with: { user: { columns: { id: true, name: true, avatarUrl: true } } }, orderBy: (comments, { desc }) => [desc(comments.createdAt)] },
          activities: { with: { user: { columns: { id: true, name: true } } }, orderBy: (activities, { desc }) => [desc(activities.createdAt)], limit: 50 },
          taskLabels: { with: { label: true } },
          timeEntries: { with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } } },
          subtasks: { with: { assignees: { with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } } } }, orderBy: (subtasks, { asc }) => [asc(subtasks.order)] },
        },
      });
      return { task };
    } catch (error) {
      console.error("Error fetching task:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /tasks/:id
  fastify.patch("/tasks/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    if (!UUID_REGEX.test(taskId)) return reply.status(400).send({ error: "Invalid task ID format" });
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });

      const body = request.body as Record<string, unknown>;
      const validatedData = updateTaskSchema.parse(body);
      const updateData: Record<string, unknown> = { updatedAt: new Date() };

      if (validatedData.title !== undefined) updateData.title = validatedData.title;
      if (validatedData.description !== undefined) updateData.description = validatedData.description;
      if (validatedData.status !== undefined) updateData.status = validatedData.status;
      if (validatedData.priority !== undefined) updateData.priority = validatedData.priority;
      if (validatedData.dueDate !== undefined) updateData.dueDate = validatedData.dueDate ? new Date(validatedData.dueDate) : null;
      if (validatedData.startDate !== undefined) updateData.startDate = validatedData.startDate ? new Date(validatedData.startDate) : null;
      if (validatedData.timeEstimate !== undefined) updateData.timeEstimate = validatedData.timeEstimate;
      if (validatedData.timeSpent !== undefined) updateData.timeSpent = validatedData.timeSpent;
      if (validatedData.order !== undefined) updateData.order = validatedData.order;
      if (validatedData.customFields !== undefined) updateData.customFields = validatedData.customFields;
      if (validatedData.parentTaskId !== undefined) updateData.parentTaskId = validatedData.parentTaskId;
      if (validatedData.listId !== undefined) {
        // Verify target list belongs to the same workspace
        const targetList = await db.query.lists.findFirst({
          where: eq(lists.id, validatedData.listId),
          with: { space: true },
        });
        if (!targetList) return reply.status(404).send({ error: "Target list not found" });
        if (targetList.space.workspaceId !== access.task.list.space.workspaceId) {
          return reply.status(400).send({ error: "Cannot move task to a list in a different workspace" });
        }
        updateData.listId = validatedData.listId;
      }

      const oldTask = access.task;
      const [updatedTask] = await db.transaction(async (tx) => {
        const [result] = await tx.update(tasks).set(updateData).where(eq(tasks.id, taskId)).returning();

        // Log activity for each changed field
        const changedFields = Object.keys(validatedData) as Array<keyof typeof validatedData>;
        for (const field of changedFields) {
          const oldValue = String(oldTask[field as keyof typeof oldTask] ?? "");
          const newValue = String(validatedData[field] ?? "");
          if (oldValue !== newValue) {
            await tx.insert(taskActivities).values({ taskId, userId: authResult.userId, action: "updated", field, oldValue, newValue });
          }
        }
        return [result];
      });

      // Trigger automations for status change
      if (validatedData.status && validatedData.status !== oldTask.status) {
        try {
          await runAutomations("status_change", {
            taskId, workspaceId: oldTask.list.space.workspaceId, userId: authResult.userId,
            oldStatus: oldTask.status ?? undefined, newStatus: validatedData.status,
          });
        } catch (err) { console.error("Error running status_change automations:", err); }
      }

      // Auto-create reminder for due date
      if (validatedData.dueDate !== undefined) {
        const newDueDate = validatedData.dueDate ? new Date(validatedData.dueDate) : null;
        const oldDueDate = oldTask.dueDate ? new Date(oldTask.dueDate) : null;
        if (newDueDate && (!oldDueDate || newDueDate.getTime() > oldDueDate.getTime())) {
          try { await autoCreateDueDateReminder(taskId, authResult.userId, newDueDate); }
          catch (err) { console.error("Error creating auto-reminder:", err); }
        }
      }

      // Broadcast SSE event
      fastify.sse.broadcastToWorkspace(oldTask.list.space.workspaceId, {
        type: "task_updated", data: { task: updatedTask, listId: oldTask.listId, userId: authResult.userId },
      });

      return { task: updatedTask };
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error updating task:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /tasks/:id
  fastify.delete("/tasks/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    if (!UUID_REGEX.test(taskId)) return reply.status(400).send({ error: "Invalid task ID format" });
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const workspaceId = access.task.list.space.workspaceId;
      const listId = access.task.listId;
      await db.delete(tasks).where(eq(tasks.id, taskId));
      fastify.sse.broadcastToWorkspace(workspaceId, { type: "task_deleted", data: { taskId, listId, userId: authResult.userId } });
      return { success: true };
    } catch (error) {
      console.error("Error deleting task:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ==================== COMMENTS ====================

  // GET /tasks/:id/comments
  fastify.get("/tasks/:id/comments", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    if (!UUID_REGEX.test(taskId)) return reply.status(400).send({ error: "Invalid task ID format" });
    const { limit: l, offset: o } = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(parseInt(l || "100", 10) || 100, 1), 500);
    const offset = Math.max(parseInt(o || "0", 10) || 0, 0);
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const comments = await db.query.taskComments.findMany({
        where: eq(taskComments.taskId, taskId),
        orderBy: [desc(taskComments.createdAt)],
        limit, offset,
        with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } },
      });
      return { comments };
    } catch (error) {
      console.error("Error fetching comments:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /tasks/:id/comments
  fastify.post("/tasks/:id/comments", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    if (!UUID_REGEX.test(taskId)) return reply.status(400).send({ error: "Invalid task ID format" });
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const body = request.body as Record<string, unknown>;
      const validatedData = createCommentSchema.parse(body);

      const [comment] = await db.insert(taskComments).values({ taskId, userId: authResult.userId, content: validatedData.content }).returning();
      await db.insert(taskActivities).values({ taskId, userId: authResult.userId, action: "added_comment", field: "comment", newValue: validatedData.content.substring(0, 100) || "comment" });

      const commentWithUser = await db.query.taskComments.findFirst({
        where: eq(taskComments.id, comment.id),
        with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } },
      });

      try {
        const taskAssigneesList = await db.query.taskAssignees.findMany({ where: eq(taskAssignees.taskId, taskId) });
        for (const assignee of taskAssigneesList) {
          if (assignee.userId !== authResult.userId) {
            await createNotification({
              userId: assignee.userId, type: "comment_added",
              title: `New comment on "${access.task.title}"`,
              message: `${commentWithUser?.user?.name || "Someone"} commented on a task you're assigned to`,
              entityType: "task", entityId: taskId, workspaceId: access.task.list.space.workspaceId,
            });
          }
        }
        if (access.task.creatorId !== authResult.userId) {
          const alreadyNotified = taskAssigneesList.some(a => a.userId === access.task.creatorId);
          if (!alreadyNotified) {
            await createNotification({
              userId: access.task.creatorId, type: "comment_added",
              title: `New comment on "${access.task.title}"`,
              message: `${commentWithUser?.user?.name || "Someone"} commented on your task`,
              entityType: "task", entityId: taskId, workspaceId: access.task.list.space.workspaceId,
            });
          }
        }
        await notifyMentions(validatedData.content, authResult.userId, "task", taskId, access.task.title, access.task.list.space.workspaceId);
      } catch (notifError) { console.error("Error sending comment notifications:", notifError); }

      return reply.status(201).send({ comment: commentWithUser });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating comment:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /tasks/:id/comments
  fastify.delete("/tasks/:id/comments", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    if (!UUID_REGEX.test(taskId)) return reply.status(400).send({ error: "Invalid task ID format" });
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const { commentId } = request.query as { commentId?: string };
      if (!commentId) return reply.status(400).send({ error: "commentId is required" });

      const comment = await db.query.taskComments.findFirst({
        where: and(eq(taskComments.id, commentId), eq(taskComments.taskId, taskId)),
      });
      if (!comment) return reply.status(404).send({ error: "Comment not found" });
      if (comment.userId !== authResult.userId && access.task.creatorId !== authResult.userId) {
        return reply.status(403).send({ error: "Not authorized to delete this comment" });
      }
      await db.delete(taskComments).where(eq(taskComments.id, commentId));
      return { success: true };
    } catch (error) {
      console.error("Error deleting comment:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ==================== ASSIGNEES ====================

  // GET /tasks/:id/assignees
  fastify.get("/tasks/:id/assignees", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const assignees = await db.query.taskAssignees.findMany({
        where: eq(taskAssignees.taskId, taskId),
        with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } },
      });
      return { assignees };
    } catch (error) {
      console.error("Error fetching assignees:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /tasks/:id/assignees
  fastify.post("/tasks/:id/assignees", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const body = request.body as Record<string, unknown>;
      const validatedData = addAssigneeSchema.parse(body);

      const userMembership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, access.task.list.space.workspaceId), eq(workspaceMembers.userId, validatedData.userId)),
      });
      if (!userMembership) return reply.status(400).send({ error: "User is not a workspace member" });

      const existing = await db.query.taskAssignees.findFirst({
        where: and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.userId, validatedData.userId)),
      });
      if (existing) return reply.status(400).send({ error: "User is already assigned to this task" });

      const assignedUser = await db.query.users.findFirst({ where: eq(users.id, validatedData.userId), columns: { id: true, name: true, email: true, avatarUrl: true } });
      const currentUser = await db.query.users.findFirst({ where: eq(users.id, authResult.userId), columns: { name: true } });

      const [assignee] = await db.transaction(async (tx) => {
        const [result] = await tx.insert(taskAssignees).values({ taskId, userId: validatedData.userId }).onConflictDoNothing().returning();
        await tx.insert(taskActivities).values({ taskId, userId: authResult.userId, action: "added_assignee", field: "assignee", newValue: assignedUser?.name || assignedUser?.email || "user" });
        return [result];
      });

      await createNotification({
        userId: validatedData.userId, type: "task_assigned",
        title: `You were assigned to "${access.task.title}"`, message: `You have been assigned to a new task`,
        entityType: "task", entityId: taskId, taskTitle: access.task.title,
        assignedBy: currentUser?.name || "Someone", workspaceId: access.task.list.space.workspaceId,
      });

      const previousAssignees = await db.query.taskAssignees.findMany({ where: eq(taskAssignees.taskId, taskId) });
      try {
        await runAutomations("assignment", {
          taskId, workspaceId: access.task.list.space.workspaceId, userId: authResult.userId,
          newAssignees: previousAssignees.map(a => a.userId),
          previousAssignees: previousAssignees.filter(a => a.userId !== validatedData.userId).map(a => a.userId),
        });
      } catch (err) { console.error("Error running assignment automations:", err); }

      return reply.status(201).send({ assignee: { ...assignee, user: assignedUser } });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error adding assignee:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /tasks/:id/assignees
  fastify.delete("/tasks/:id/assignees", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const { userId } = request.query as { userId?: string };
      if (!userId) return reply.status(400).send({ error: "userId is required" });

      const removedUser = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { id: true, name: true, email: true } });
      await db.transaction(async (tx) => {
        await tx.delete(taskAssignees).where(and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.userId, userId)));
        await tx.insert(taskActivities).values({ taskId, userId: authResult.userId, action: "removed_assignee", field: "assignee", oldValue: removedUser?.name || removedUser?.email || "user" });
      });
      return { success: true };
    } catch (error) {
      console.error("Error removing assignee:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ==================== LABELS ====================

  // GET /tasks/:id/labels
  fastify.get("/tasks/:id/labels", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found" });
      const taskLabelRelations = await db.query.taskLabels.findMany({ where: eq(taskLabels.taskId, taskId), with: { label: true } });
      return { labels: taskLabelRelations.map(tl => tl.label) };
    } catch (error) {
      console.error("Error fetching task labels:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /tasks/:id/labels
  fastify.post("/tasks/:id/labels", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found" });
      const body = request.body as Record<string, unknown>;
      const parsed = addLabelSchema.safeParse(body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });

      const label = await db.query.labels.findFirst({
        where: and(eq(labels.id, parsed.data.labelId), eq(labels.workspaceId, access.task.list.space.workspaceId)),
      });
      if (!label) return reply.status(404).send({ error: "Label not found in this workspace" });

      const existing = await db.query.taskLabels.findFirst({
        where: and(eq(taskLabels.taskId, taskId), eq(taskLabels.labelId, parsed.data.labelId)),
      });
      if (existing) return reply.status(409).send({ error: "Label already assigned to this task" });

      await db.insert(taskLabels).values({ taskId, labelId: parsed.data.labelId });
      return reply.status(201).send({ success: true });
    } catch (error) {
      console.error("Error adding label to task:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /tasks/:id/labels
  fastify.delete("/tasks/:id/labels", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found" });
      const { labelId } = request.query as { labelId?: string };
      if (!labelId) return reply.status(400).send({ error: "labelId query parameter is required" });

      const existing = await db.query.taskLabels.findFirst({
        where: and(eq(taskLabels.taskId, taskId), eq(taskLabels.labelId, labelId)),
      });
      if (!existing) return reply.status(404).send({ error: "Label not assigned to this task" });

      await db.delete(taskLabels).where(and(eq(taskLabels.taskId, taskId), eq(taskLabels.labelId, labelId)));
      return { success: true };
    } catch (error) {
      console.error("Error removing label from task:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ==================== SUBTASKS ====================

  // GET /tasks/:id/subtasks
  fastify.get("/tasks/:id/subtasks", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const subtaskList = await db.query.tasks.findMany({
        where: eq(tasks.parentTaskId, taskId),
        orderBy: [asc(tasks.order)],
        with: {
          assignees: { with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } } },
          creator: { columns: { id: true, name: true, email: true, avatarUrl: true } },
        },
      });
      return { subtasks: subtaskList };
    } catch (error) {
      console.error("Error fetching subtasks:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /tasks/:id/subtasks
  fastify.post("/tasks/:id/subtasks", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const body = request.body as Record<string, unknown>;
      const validatedData = createSubtaskSchema.parse(body);

      const [subtask] = await db.transaction(async (tx) => {
        const [result] = await tx.insert(tasks).values({
          listId: access.task.listId, title: validatedData.title, description: validatedData.description ?? {},
          status: validatedData.status ?? "todo", priority: validatedData.priority ?? "none",
          creatorId: authResult.userId, dueDate: validatedData.dueDate ? new Date(validatedData.dueDate) : null,
          timeEstimate: validatedData.timeEstimate, order: validatedData.order ?? 0, parentTaskId: taskId,
        }).returning();
        await tx.insert(taskActivities).values({ taskId, userId: authResult.userId, action: "subtask_created", newValue: result.id });
        return [result];
      });
      return reply.status(201).send({ subtask });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating subtask:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /tasks/:id/subtasks
  fastify.delete("/tasks/:id/subtasks", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const { subtaskId } = request.query as { subtaskId?: string };
      if (!subtaskId) return reply.status(400).send({ error: "subtaskId is required" });

      const subtask = await db.query.tasks.findFirst({ where: and(eq(tasks.id, subtaskId), eq(tasks.parentTaskId, taskId)) });
      if (!subtask) return reply.status(404).send({ error: "Subtask not found" });
      await db.delete(tasks).where(eq(tasks.id, subtaskId));
      return { success: true };
    } catch (error) {
      console.error("Error deleting subtask:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ==================== ATTACHMENTS ====================

  // GET /tasks/:id/attachments
  fastify.get("/tasks/:id/attachments", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(403).send({ error: "Access denied" });
      const attachments = await db.select({
        id: taskAttachments.id, taskId: taskAttachments.taskId, filename: taskAttachments.filename,
        fileKey: taskAttachments.fileKey, fileSize: taskAttachments.fileSize, mimeType: taskAttachments.mimeType,
        uploadedBy: taskAttachments.uploadedBy, createdAt: taskAttachments.createdAt,
      }).from(taskAttachments).where(eq(taskAttachments.taskId, taskId)).orderBy(desc(taskAttachments.createdAt));
      return attachments.map(a => ({ ...a, url: `/api/files/${a.fileKey}` }));
    } catch (error) {
      console.error("Error fetching attachments:", error);
      return reply.status(500).send({ error: "Failed to fetch attachments" });
    }
  });

  // POST /tasks/:id/attachments
  fastify.post("/tasks/:id/attachments", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(403).send({ error: "Access denied" });

      const data = await request.file();
      if (!data) return reply.status(400).send({ error: "No file provided" });

      const mimeType = data.mimetype;
      if (!ALLOWED_TYPES.includes(mimeType)) {
        return reply.status(400).send({ error: "Invalid file type. Allowed: images, videos, PDF, DOC, DOCX, XLS, XLSX, TXT, CSV, ZIP" });
      }

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) { chunks.push(chunk); }
      const buffer = Buffer.concat(chunks);
      if (buffer.length > MAX_SIZE) return reply.status(400).send({ error: "File too large. Max 50MB allowed." });

      const ext = data.filename.split(".").pop() || "bin";
      const key = `attachments/${taskId}/${randomUUID()}.${ext}`;

      await s3Client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: mimeType }));

      const [attachment] = await db.transaction(async (tx) => {
        const [result] = await tx.insert(taskAttachments).values({
          taskId, filename: data.filename, fileKey: key, fileSize: buffer.length, mimeType, uploadedBy: authResult.userId,
        }).returning({
          id: taskAttachments.id, taskId: taskAttachments.taskId, filename: taskAttachments.filename,
          fileKey: taskAttachments.fileKey, fileSize: taskAttachments.fileSize, mimeType: taskAttachments.mimeType,
          uploadedBy: taskAttachments.uploadedBy, createdAt: taskAttachments.createdAt,
        });
        await tx.insert(taskActivities).values({ taskId, userId: authResult.userId, action: "added_attachment", field: "attachment", newValue: data.filename });
        return [result];
      });
      return { ...attachment, url: `/api/files/${attachment.fileKey}` };
    } catch (error) {
      console.error("Upload error:", error);
      return reply.status(500).send({ error: "Failed to upload file" });
    }
  });

  // DELETE /tasks/:id/attachments
  fastify.delete("/tasks/:id/attachments", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(403).send({ error: "Access denied" });
      const { attachmentId } = request.query as { attachmentId?: string };
      if (!attachmentId) return reply.status(400).send({ error: "Attachment ID required" });

      const [attachment] = await db.select({ id: taskAttachments.id, filename: taskAttachments.filename, fileKey: taskAttachments.fileKey })
        .from(taskAttachments).where(and(eq(taskAttachments.id, attachmentId), eq(taskAttachments.taskId, taskId))).limit(1);
      if (!attachment) return reply.status(404).send({ error: "Attachment not found" });

      await db.transaction(async (tx) => {
        await tx.delete(taskAttachments).where(eq(taskAttachments.id, attachmentId));
        await tx.insert(taskActivities).values({ taskId, userId: authResult.userId, action: "removed_attachment", field: "attachment", oldValue: attachment.filename });
      });
      // Delete from S3 after DB commit succeeds
      await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: attachment.fileKey })).catch((err) => {
        console.error("Failed to delete file from S3:", err);
      });
      return { success: true };
    } catch (error) {
      console.error("Delete error:", error);
      return reply.status(500).send({ error: "Failed to delete attachment" });
    }
  });

  // ==================== TIME ENTRIES ====================

  // GET /tasks/:id/time-entries
  fastify.get("/tasks/:id/time-entries", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const entries = await db.query.timeEntries.findMany({
        where: eq(timeEntries.taskId, taskId),
        orderBy: [desc(timeEntries.startTime)],
        with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } },
      });
      const totalSeconds = entries.reduce((sum, entry) => sum + (entry.duration || 0), 0);
      return { timeEntries: entries, totalTimeSpent: totalSeconds };
    } catch (error) {
      console.error("Error fetching time entries:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /tasks/:id/time-entries
  fastify.post("/tasks/:id/time-entries", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const body = request.body as Record<string, unknown>;
      const action = (body as { action?: string }).action;

      if (action === "stop") {
        const runningEntry = await db.query.timeEntries.findFirst({
          where: and(eq(timeEntries.taskId, taskId), eq(timeEntries.userId, authResult.userId), isNull(timeEntries.endTime), isNull(timeEntries.duration)),
          orderBy: [desc(timeEntries.startTime)],
        });
        if (!runningEntry) return reply.status(400).send({ error: "No running timer found" });

        const endTime = new Date();
        const startTime = new Date(runningEntry.startTime);
        const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);

        const [updatedEntry] = await db.transaction(async (tx) => {
          const [result] = await tx.update(timeEntries).set({
            endTime, duration, description: (body as { description?: string }).description || runningEntry.description,
          }).where(eq(timeEntries.id, runningEntry.id)).returning();

          const allEntries = await db.query.timeEntries.findMany({ where: eq(timeEntries.taskId, taskId) });
          const totalTimeSpent = allEntries.reduce((sum, e) => sum + (e.duration || 0), 0);
          await tx.update(tasks).set({ timeSpent: totalTimeSpent }).where(eq(tasks.id, taskId));

          await tx.insert(taskActivities).values({ taskId, userId: authResult.userId, action: "stopped_timer", field: "time_tracking", newValue: `${Math.floor(duration / 60)} minutes` });
          return [result];
        });
        return { timeEntry: updatedEntry };
      }

      if (action === "start") {
        const existingTimer = await db.query.timeEntries.findFirst({
          where: and(eq(timeEntries.taskId, taskId), eq(timeEntries.userId, authResult.userId), isNull(timeEntries.endTime), isNull(timeEntries.duration)),
        });
        if (existingTimer) return reply.status(400).send({ error: "Timer already running. Stop it first." });

        const [entry] = await db.transaction(async (tx) => {
          const [result] = await tx.insert(timeEntries).values({
            taskId, userId: authResult.userId, startTime: new Date(), description: (body as { description?: string }).description,
          }).returning();
          await tx.insert(taskActivities).values({ taskId, userId: authResult.userId, action: "started_timer", field: "time_tracking" });
          return [result];
        });
        return reply.status(201).send({ timeEntry: entry });
      }

      // Manual time entry
      const validatedData = createTimeEntrySchema.parse(body);
      let startTime = validatedData.startTime ? new Date(validatedData.startTime) : new Date();
      let endTime: Date | null = null;
      let duration: number | null = null;

      if (validatedData.endTime) {
        endTime = new Date(validatedData.endTime);
        duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);
      } else if (validatedData.duration !== undefined) {
        duration = validatedData.duration;
      }

      const [entry] = await db.transaction(async (tx) => {
        const [result] = await tx.insert(timeEntries).values({
          taskId, userId: authResult.userId, startTime, endTime, duration, description: validatedData.description,
        }).returning();

        if (duration) {
          const allEntries = await db.query.timeEntries.findMany({ where: eq(timeEntries.taskId, taskId) });
          const totalTimeSpent = allEntries.reduce((sum, e) => sum + (e.duration || 0), 0);
          await tx.update(tasks).set({ timeSpent: totalTimeSpent }).where(eq(tasks.id, taskId));
        }
        return [result];
      });
      return reply.status(201).send({ timeEntry: entry });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error with time entry:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /tasks/:id/time-entries
  fastify.delete("/tasks/:id/time-entries", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const { entryId } = request.query as { entryId?: string };
      if (!entryId) return reply.status(400).send({ error: "entryId is required" });

      const entry = await db.query.timeEntries.findFirst({
        where: and(eq(timeEntries.id, entryId), eq(timeEntries.taskId, taskId)),
      });
      if (!entry) return reply.status(404).send({ error: "Time entry not found" });
      if (entry.userId !== authResult.userId) return reply.status(403).send({ error: "Not authorized to delete this time entry" });

      await db.transaction(async (tx) => {
        await tx.delete(timeEntries).where(eq(timeEntries.id, entryId));
        // Recalculate total time spent
        const allEntries = await db.query.timeEntries.findMany({ where: eq(timeEntries.taskId, taskId) });
        const totalTimeSpent = allEntries.reduce((sum, e) => sum + (e.duration || 0), 0);
        await tx.update(tasks).set({ timeSpent: totalTimeSpent }).where(eq(tasks.id, taskId));
      });

      return { success: true };
    } catch (error) {
      console.error("Error deleting time entry:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ==================== REMINDERS ====================

  // GET /tasks/:id/reminders
  fastify.get("/tasks/:id/reminders", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const taskReminders = await db.query.reminders.findMany({
        where: eq(reminders.taskId, taskId),
        orderBy: [desc(reminders.remindAt)],
        with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } },
      });
      return { reminders: taskReminders };
    } catch (error) {
      console.error("Error fetching reminders:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /tasks/:id/reminders
  fastify.post("/tasks/:id/reminders", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const body = request.body as Record<string, unknown>;
      const validatedData = createReminderSchema.parse(body);

      let remindAtDate: Date;
      if (validatedData.preset && validatedData.preset !== "custom" && access.task.dueDate) {
        const calculated = calculateRemindAt(validatedData.preset, new Date(access.task.dueDate));
        if (!calculated) return reply.status(400).send({ error: "Task has no due date to calculate reminder from" });
        remindAtDate = calculated;
      } else {
        remindAtDate = new Date(validatedData.remindAt);
      }

      const existingReminder = await db.query.reminders.findFirst({
        where: and(eq(reminders.taskId, taskId), eq(reminders.userId, authResult.userId), eq(reminders.remindAt, remindAtDate)),
      });
      if (existingReminder) return reply.status(409).send({ error: "A reminder already exists for this time" });

      const [reminder] = await db.insert(reminders).values({ taskId, userId: authResult.userId, remindAt: remindAtDate, type: validatedData.type }).returning();
      const reminderWithUser = await db.query.reminders.findFirst({
        where: eq(reminders.id, reminder.id),
        with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } },
      });
      return reply.status(201).send({ reminder: reminderWithUser });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating reminder:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /tasks/:id/reminders
  fastify.delete("/tasks/:id/reminders", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const { reminderId } = request.query as { reminderId?: string };
      if (!reminderId) return reply.status(400).send({ error: "reminderId is required" });

      const reminder = await db.query.reminders.findFirst({ where: and(eq(reminders.id, reminderId), eq(reminders.taskId, taskId)) });
      if (!reminder) return reply.status(404).send({ error: "Reminder not found" });
      if (reminder.userId !== authResult.userId && access.task.creatorId !== authResult.userId) {
        return reply.status(403).send({ error: "Not authorized to delete this reminder" });
      }
      await db.delete(reminders).where(eq(reminders.id, reminderId));
      return { success: true };
    } catch (error) {
      console.error("Error deleting reminder:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ==================== DEPENDENCIES ====================

  // GET /tasks/:id/dependencies
  fastify.get("/tasks/:id/dependencies", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
      return { blockedBy: (task?.blockedBy as string[] || []), blocks: (task?.blocks as string[] || []) };
    } catch (error) {
      console.error("Error fetching dependencies:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /tasks/:id/dependencies
  fastify.post("/tasks/:id/dependencies", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const body = request.body as Record<string, unknown>;
      const validatedData = linkDependencySchema.parse(body);
      const { blockedTaskId } = validatedData;

      const blockedTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, blockedTaskId), with: { list: { with: { space: true } } },
      });
      if (!blockedTask) return reply.status(404).send({ error: "Blocked task not found" });

      const blockedMembership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, blockedTask.list.space.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!blockedMembership) return reply.status(403).send({ error: "Access denied to blocked task" });
      if (blockedTaskId === taskId) return reply.status(400).send({ error: "A task cannot block itself" });

      const taskBlocks = (access.task.blocks as string[] || []);
      const taskBlockedBy = (access.task.blockedBy as string[] || []);
      if (taskBlocks.includes(blockedTaskId) || taskBlockedBy.includes(blockedTaskId)) {
        return reply.status(400).send({ error: "Dependency already exists" });
      }

      const newBlockedBy = [...taskBlockedBy, blockedTaskId];
      const currentBlocks = (blockedTask.blocks as string[] || []);

      await db.transaction(async (tx) => {
        await tx.update(tasks).set({ blockedBy: newBlockedBy, updatedAt: new Date() }).where(eq(tasks.id, taskId));
        await tx.update(tasks).set({ blocks: [...currentBlocks, taskId], updatedAt: new Date() }).where(eq(tasks.id, blockedTaskId));
        await tx.insert(taskActivities).values({ taskId, userId: authResult.userId, action: "dependency_added", field: "blockedBy", newValue: blockedTaskId });
      });
      return { success: true, blockedBy: newBlockedBy };
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error linking dependency:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /tasks/:id/dependencies
  fastify.delete("/tasks/:id/dependencies", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const { blockedTaskId } = request.query as { blockedTaskId?: string };
      if (!blockedTaskId) return reply.status(400).send({ error: "blockedTaskId is required" });

      const blockedTask = await db.query.tasks.findFirst({ where: eq(tasks.id, blockedTaskId) });
      if (!blockedTask) return reply.status(404).send({ error: "Blocked task not found" });

      const currentBlockedBy = (access.task.blockedBy as string[] || []);
      const newBlockedBy = currentBlockedBy.filter((id: string) => id !== blockedTaskId);
      const currentBlocks = (blockedTask.blocks as string[] || []);
      const newBlocks = currentBlocks.filter((id: string) => id !== taskId);

      await db.transaction(async (tx) => {
        await tx.update(tasks).set({ blockedBy: newBlockedBy, updatedAt: new Date() }).where(eq(tasks.id, taskId));
        await tx.update(tasks).set({ blocks: newBlocks, updatedAt: new Date() }).where(eq(tasks.id, blockedTaskId));
        await tx.insert(taskActivities).values({ taskId, userId: authResult.userId, action: "dependency_removed", field: "blockedBy", oldValue: blockedTaskId });
      });
      return { success: true, blockedBy: newBlockedBy };
    } catch (error) {
      console.error("Error unlinking dependency:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ==================== SPRINT ====================

  // GET /tasks/:id/sprint
  fastify.get("/tasks/:id/sprint", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });

      const sprintTaskRelations = await db.select({
        sprintId: sprintTasks.sprintId, sprintName: sprints.name, sprintStatus: sprints.status,
        sprintStartDate: sprints.startDate, sprintEndDate: sprints.endDate,
      }).from(sprintTasks).innerJoin(sprints, eq(sprintTasks.sprintId, sprints.id)).where(eq(sprintTasks.taskId, taskId));

      return {
        sprints: sprintTaskRelations.map(st => ({
          id: st.sprintId, name: st.sprintName, status: st.sprintStatus,
          startDate: st.sprintStartDate?.toISOString() || "", endDate: st.sprintEndDate?.toISOString() || "",
        })),
      };
    } catch (error) {
      console.error("Error fetching task sprint:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PUT /tasks/:id/sprint
  fastify.put("/tasks/:id/sprint", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });
      const body = request.body as Record<string, unknown>;
      const validatedData = assignSprintSchema.parse(body);
      const { sprintId } = validatedData;

      const sprint = await db.query.sprints.findFirst({ where: eq(sprints.id, sprintId) });
      if (!sprint) return reply.status(404).send({ error: "Sprint not found" });
      if (sprint.workspaceId !== access.task.list.space.workspaceId) {
        return reply.status(400).send({ error: "Sprint must be in the same workspace as the task" });
      }

      await db.delete(sprintTasks).where(eq(sprintTasks.taskId, taskId));
      await db.insert(sprintTasks).values({ sprintId, taskId });
      await db.insert(taskActivities).values({ taskId, userId: authResult.userId, action: "updated", field: "sprint", newValue: sprint.name });
      return { success: true };
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error assigning task to sprint:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /tasks/:id/sprint
  fastify.delete("/tasks/:id/sprint", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: taskId } = request.params as { id: string };
    try {
      const access = await checkTaskAccess(taskId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Task not found or access denied" });

      const currentSprint = await db.select({ sprintId: sprintTasks.sprintId, sprintName: sprints.name })
        .from(sprintTasks).innerJoin(sprints, eq(sprintTasks.sprintId, sprints.id)).where(eq(sprintTasks.taskId, taskId)).limit(1);
      const sprintName = currentSprint[0]?.sprintName || "sprint";

      await db.delete(sprintTasks).where(eq(sprintTasks.taskId, taskId));
      await db.insert(taskActivities).values({ taskId, userId: authResult.userId, action: "updated", field: "sprint", oldValue: sprintName, newValue: null });
      return { success: true };
    } catch (error) {
      console.error("Error removing task from sprints:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
