import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and, asc, notInArray, sql } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";
import { runAutomations } from "../../lib/automations.js";
import { broadcastToWorkspace } from "../../plugins/sse.js";

const { lists, spaces, tasks, taskActivities, workspaceMembers, customFieldDefinitions } = schema;

async function checkListAccess(listId: string, userId: string) {
  const list = await db.query.lists.findFirst({ where: eq(lists.id, listId), with: { space: true } });
  if (!list) return null;
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, list.space.workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return membership ? { list, space: list.space, membership } : null;
}

const updateListSchema = z.object({ name: z.string().min(1).max(255).optional() });

const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.record(z.string(), z.unknown()).optional(),
  status: z.string().max(50).optional(),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
  dueDate: z.string().datetime().optional(),
  timeEstimate: z.number().min(0).optional(),
  order: z.number().optional(),
  parentTaskId: z.string().uuid().optional(),
});

function toDescriptionDoc(desc: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!desc) return {};
  if (typeof desc === "object") return desc;
  if (desc.trim() === "") return {};
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: desc }] }] };
}

const bulkCreateTaskSchema = z.object({
  tasks: z.array(z.object({
    title: z.string().min(1).max(500),
    description: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    status: z.string().max(50).optional(),
    priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
    dueDate: z.string().datetime().optional(),
    timeEstimate: z.number().min(0).optional(),
    order: z.number().optional(),
    parentTaskId: z.string().uuid().optional(),
  })),
});

export default async function listRoutes(fastify: FastifyInstance) {
  // GET /lists/:id
  fastify.get("/lists/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const access = await checkListAccess(id, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });
      return { list: access.list };
    } catch (error) {
      console.error("Error fetching list:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /lists/:id
  fastify.patch("/lists/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const access = await checkListAccess(id, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });
      const body = request.body as Record<string, unknown>;
      const parsed = updateListSchema.safeParse(body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid data", details: parsed.error.flatten() });
      const [updated] = await db.update(lists).set(parsed.data).where(eq(lists.id, id)).returning();
      return { list: updated };
    } catch (error) {
      console.error("Error updating list:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /lists/:id
  fastify.delete("/lists/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const access = await checkListAccess(id, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });
      if (!["owner", "admin"].includes(access.membership.role)) return reply.status(403).send({ error: "Only owners and admins can delete lists" });
      await db.delete(lists).where(eq(lists.id, id));
      return { success: true };
    } catch (error) {
      console.error("Error deleting list:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /lists/:id/tasks
  fastify.get("/lists/:id/tasks", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: listId } = request.params as { id: string };
    const { limit: l, offset: o, includeClosed } = request.query as { limit?: string; offset?: string; includeClosed?: string };
    const limit = Math.min(Math.max(parseInt(l || "200", 10) || 200, 1), 500);
    const offset = Math.max(parseInt(o || "0", 10) || 0, 0);
    const closedStatuses = ["done", "closed", "complete"];
    try {
      const access = await checkListAccess(listId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });
      const listTasks = await db.query.tasks.findMany({
        where: includeClosed === "true"
          ? eq(tasks.listId, listId)
          : and(eq(tasks.listId, listId), notInArray(tasks.status, closedStatuses)),
        orderBy: [asc(tasks.order)],
        limit, offset,
        with: {
          assignees: { with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } } },
          creator: { columns: { id: true, name: true, email: true, avatarUrl: true } },
        },
      });
      const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(tasks).where(and(eq(tasks.listId, listId), sql`${tasks.status} IN ('done', 'closed', 'complete')`));
      const closedCount = countResult?.count ?? 0;
      return { tasks: listTasks, closedCount };
    } catch (error) {
      console.error("Error fetching tasks:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /lists/:id/tasks
  fastify.post("/lists/:id/tasks", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: listId } = request.params as { id: string };
    try {
      const access = await checkListAccess(listId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });
      const body = request.body as Record<string, unknown>;
      const validatedData = createTaskSchema.parse(body);
      const [task] = await db.insert(tasks).values({
        listId, title: validatedData.title, description: validatedData.description ?? {},
        status: validatedData.status ?? "todo", priority: validatedData.priority ?? "none",
        creatorId: authResult.userId, dueDate: validatedData.dueDate ? new Date(validatedData.dueDate) : null,
        timeEstimate: validatedData.timeEstimate, order: validatedData.order ?? 0, parentTaskId: validatedData.parentTaskId,
      }).returning();

      await db.insert(taskActivities).values({ taskId: task.id, userId: authResult.userId, action: "created" });
      try { await runAutomations("task_created", { taskId: task.id, workspaceId: access.space.workspaceId, userId: authResult.userId }); } catch (err) { console.error("Error running automations:", err); }
      broadcastToWorkspace(access.space.workspaceId, { type: "task_created", data: { task, listId, spaceId: access.space.id, userId: authResult.userId } });
      return reply.status(201).send({ task });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating task:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /lists/:id/tasks/bulk
  fastify.post("/lists/:id/tasks/bulk", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: listId } = request.params as { id: string };
    try {
      const access = await checkListAccess(listId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });
      const body = request.body as Record<string, unknown>;
      const { tasks: tasksToCreate } = bulkCreateTaskSchema.parse(body);

      const existingTasks = await db.query.tasks.findMany({
        where: eq(tasks.listId, listId), columns: { order: true }, orderBy: (t, { desc }) => [desc(t.order)], limit: 1,
      });
      const startOrder = existingTasks[0]?.order != null ? existingTasks[0].order + 1 : 0;

      const createdTasks = await Promise.all(tasksToCreate.map(async (taskData, index) => {
        const [task] = await db.insert(tasks).values({
          listId, title: taskData.title, description: toDescriptionDoc(taskData.description),
          status: taskData.status ?? "todo", priority: taskData.priority ?? "none",
          creatorId: authResult.userId, dueDate: taskData.dueDate ? new Date(taskData.dueDate) : null,
          timeEstimate: taskData.timeEstimate, order: taskData.order ?? startOrder + index, parentTaskId: taskData.parentTaskId,
        }).returning();
        await db.insert(taskActivities).values({ taskId: task.id, userId: authResult.userId, action: "created" });
        return task;
      }));

      for (const task of createdTasks) {
        try { await runAutomations("task_created", { taskId: task.id, workspaceId: access.space.workspaceId, userId: authResult.userId }); } catch (err) { console.error("Error running automations:", err); }
      }
      return reply.status(201).send({ tasks: createdTasks });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating bulk tasks:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /lists/:id/custom-fields
  fastify.get("/lists/:id/custom-fields", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: listId } = request.params as { id: string };
    try {
      const access = await checkListAccess(listId, authResult.userId);
      if (!access) return reply.status(403).send({ error: "Access denied" });
      const fields = await db.select().from(customFieldDefinitions).where(eq(customFieldDefinitions.listId, listId)).orderBy(asc(customFieldDefinitions.order));
      return { fields };
    } catch (error) {
      console.error("Error fetching custom fields:", error);
      return reply.status(500).send({ error: "Failed to fetch custom fields" });
    }
  });

  // POST /lists/:id/custom-fields
  fastify.post("/lists/:id/custom-fields", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: listId } = request.params as { id: string };
    try {
      const access = await checkListAccess(listId, authResult.userId);
      if (!access) return reply.status(403).send({ error: "Access denied" });
      const { name, type, options } = request.body as { name?: string; type?: string; options?: Record<string, unknown> };
      if (!name) return reply.status(400).send({ error: "Field name is required" });
      const validTypes = ["text", "textarea", "number", "date", "time", "datetime", "checkbox", "select", "multiSelect", "url", "email", "phone", "currency", "percentage", "user"];
      if (!type || !validTypes.includes(type)) return reply.status(400).send({ error: `Invalid field type. Valid types: ${validTypes.join(", ")}` });

      const max = await db.select({ order: customFieldDefinitions.order }).from(customFieldDefinitions).where(eq(customFieldDefinitions.listId, listId)).orderBy(customFieldDefinitions.order).limit(1);
      const newOrder = max.length > 0 ? (max[0].order ?? 0) + 1 : 0;

      const [newField] = await db.insert(customFieldDefinitions).values({ listId, name, type, options: options || {}, order: newOrder }).returning();
      return reply.status(201).send({ field: newField });
    } catch (error) {
      console.error("Error creating custom field:", error);
      return reply.status(500).send({ error: "Failed to create custom field" });
    }
  });

  // PUT /lists/:id/custom-fields/:fieldId
  fastify.put("/lists/:id/custom-fields/:fieldId", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: listId, fieldId } = request.params as { id: string; fieldId: string };
    try {
      const access = await checkListAccess(listId, authResult.userId);
      if (!access) return reply.status(403).send({ error: "Access denied" });
      const { name, type, options, order } = request.body as { name?: string; type?: string; options?: Record<string, unknown>; order?: number };
      const validTypes = ["text", "textarea", "number", "date", "time", "datetime", "checkbox", "select", "multiSelect", "url", "email", "phone", "currency", "percentage", "user"];
      if (type && !validTypes.includes(type)) return reply.status(400).send({ error: `Invalid field type` });

      const updateData: Record<string, unknown> = {};
      if (name !== undefined) updateData.name = name;
      if (type !== undefined) updateData.type = type;
      if (options !== undefined) updateData.options = options;
      if (order !== undefined) updateData.order = order;

      const [updated] = await db.update(customFieldDefinitions).set(updateData).where(and(eq(customFieldDefinitions.id, fieldId), eq(customFieldDefinitions.listId, listId))).returning();
      if (!updated) return reply.status(404).send({ error: "Custom field not found" });
      return { field: updated };
    } catch (error) {
      console.error("Error updating custom field:", error);
      return reply.status(500).send({ error: "Failed to update custom field" });
    }
  });

  // DELETE /lists/:id/custom-fields/:fieldId
  fastify.delete("/lists/:id/custom-fields/:fieldId", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: listId, fieldId } = request.params as { id: string; fieldId: string };
    try {
      const access = await checkListAccess(listId, authResult.userId);
      if (!access) return reply.status(403).send({ error: "Access denied" });
      if (!["owner", "admin"].includes(access.membership.role)) return reply.status(403).send({ error: "Only owners and admins can delete custom fields" });
      const [deleted] = await db.delete(customFieldDefinitions).where(and(eq(customFieldDefinitions.id, fieldId), eq(customFieldDefinitions.listId, listId))).returning();
      if (!deleted) return reply.status(404).send({ error: "Custom field not found" });
      return { success: true };
    } catch (error) {
      console.error("Error deleting custom field:", error);
      return reply.status(500).send({ error: "Failed to delete custom field" });
    }
  });
}
