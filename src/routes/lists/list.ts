import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and, asc, notInArray, sql } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";
import { runAutomations } from "../../lib/automations.js";
import { broadcastToWorkspace } from "../../plugins/sse.js";
import { syncJunctionForListChange } from "../../lib/sprint-list.js";

const { lists, spaces, tasks, taskActivities, workspaceMembers } = schema;

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
  // Returns up to `limit` tasks (default 1000, max 5000). Order is deterministic
  // — `(order ASC, created_at ASC, id ASC)` — so any future cursor-paginated
  // client gets stable pages. `total` and `hasMore` let callers detect when
  // a list legitimately exceeds the cap (today's lists shouldn't, post-PR-3).
  fastify.get("/lists/:id/tasks", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: listId } = request.params as { id: string };
    const { limit: l, offset: o, includeClosed } = request.query as { limit?: string; offset?: string; includeClosed?: string };
    const limit = Math.min(Math.max(parseInt(l || "1000", 10) || 1000, 1), 5000);
    const offset = Math.max(parseInt(o || "0", 10) || 0, 0);
    const closedStatuses = ["done", "closed", "complete"];
    try {
      const access = await checkListAccess(listId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });

      const whereClause = includeClosed === "true"
        ? eq(tasks.listId, listId)
        : and(eq(tasks.listId, listId), notInArray(tasks.status, closedStatuses));

      const listTasks = await db.query.tasks.findMany({
        where: whereClause,
        // Deterministic tiebreakers so two tasks with identical `order` (the
        // common default of 0) don't shuffle between requests.
        orderBy: [asc(tasks.order), asc(tasks.createdAt), asc(tasks.id)],
        limit, offset,
        with: {
          assignees: { with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } } },
          creator: { columns: { id: true, name: true, email: true, avatarUrl: true } },
        },
      });

      // Total count of tasks the WHERE clause matches — lets the client warn
      // when its rendered set is shorter than the actual list (limit hit).
      const [totalResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(whereClause);
      const total = totalResult?.count ?? 0;

      const [closedResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(and(eq(tasks.listId, listId), sql`${tasks.status} IN ('done', 'closed', 'complete')`));
      const closedCount = closedResult?.count ?? 0;

      return {
        tasks: listTasks,
        closedCount,
        total,
        hasMore: total > offset + listTasks.length,
      };
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
      // Model B: if this list represents a sprint, the new task is implicitly
      // in that sprint — write the sprint_tasks row so burndown / retro / etc.
      // pick it up.
      try { await syncJunctionForListChange(task.id, listId); } catch (err) { console.error("Error syncing sprint_tasks junction:", err); }
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

      // Model B: if this list represents a sprint, all bulk-created tasks
      // are implicitly in that sprint — write sprint_tasks rows for each.
      try {
        for (const task of createdTasks) {
          await syncJunctionForListChange(task.id, listId);
        }
      } catch (err) { console.error("Error syncing sprint_tasks junction (bulk):", err); }

      for (const task of createdTasks) {
        try { await runAutomations("task_created", { taskId: task.id, workspaceId: access.space.workspaceId, userId: authResult.userId }); } catch (err) { console.error("Error running automations:", err); }
        broadcastToWorkspace(access.space.workspaceId, { type: "task_created", data: { task, listId, spaceId: access.space.id, userId: authResult.userId } });
      }
      return reply.status(201).send({ tasks: createdTasks });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating bulk tasks:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

}
