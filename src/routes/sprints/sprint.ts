import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and, asc, gte, lte, inArray } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { sprints, workspaceMembers, sprintTasks, tasks, taskActivities } = schema;

const updateSprintSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  status: z.enum(["planned", "active", "completed"]).optional(),
  goal: z.string().nullable().optional(),
});

const addTaskSchema = z.object({ taskId: z.string().uuid() });
const moveTaskSchema = z.object({
  fromSprintId: z.string().uuid(),
  toSprintId: z.string().uuid(),
  taskId: z.string().uuid(),
});

async function checkSprintAccess(sprintId: string, userId: string) {
  const sprint = await db.query.sprints.findFirst({ where: eq(sprints.id, sprintId) });
  if (!sprint) return null;
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, sprint.workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return membership ? { sprint, membership } : null;
}

export default async function sprintRoutes(fastify: FastifyInstance) {
  // GET /sprints/:id
  fastify.get("/sprints/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: sprintId } = request.params as { id: string };
    try {
      const access = await checkSprintAccess(sprintId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Sprint not found" });

      const sprintTaskRelations = await db.query.sprintTasks.findMany({
        where: eq(sprintTasks.sprintId, sprintId),
        with: {
          task: {
            with: {
              assignees: { with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } } },
              creator: { columns: { id: true, name: true, email: true } },
              list: { columns: { id: true, name: true } },
            },
          },
        },
      });

      const tasksWithDetails = sprintTaskRelations.map(st => ({
        ...st.task,
        dueDate: st.task.dueDate ? new Date(st.task.dueDate).toISOString() : null,
        createdAt: st.task.createdAt ? new Date(st.task.createdAt).toISOString() : st.task.createdAt,
        updatedAt: st.task.updatedAt ? new Date(st.task.updatedAt).toISOString() : st.task.updatedAt,
      }));

      return { sprint: access.sprint, tasks: tasksWithDetails };
    } catch (error) {
      console.error("Error fetching sprint:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /sprints/:id
  fastify.patch("/sprints/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: sprintId } = request.params as { id: string };
    try {
      const access = await checkSprintAccess(sprintId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Sprint not found" });
      if (!["owner", "admin"].includes(access.membership.role)) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const validatedData = updateSprintSchema.parse(body);
      const updateData: Record<string, unknown> = {};
      if (validatedData.name !== undefined) updateData.name = validatedData.name;
      if (validatedData.startDate !== undefined) updateData.startDate = new Date(validatedData.startDate);
      if (validatedData.endDate !== undefined) updateData.endDate = new Date(validatedData.endDate);
      if (validatedData.status !== undefined) updateData.status = validatedData.status;
      if (validatedData.goal !== undefined) updateData.goal = validatedData.goal;

      const [updatedSprint] = await db.update(sprints).set(updateData).where(eq(sprints.id, sprintId)).returning();
      return { sprint: updatedSprint };
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error updating sprint:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /sprints/:id
  fastify.delete("/sprints/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: sprintId } = request.params as { id: string };
    try {
      const access = await checkSprintAccess(sprintId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Sprint not found" });
      if (!["owner", "admin"].includes(access.membership.role)) return reply.status(403).send({ error: "Access denied" });

      await db.transaction(async (tx) => {
        await tx.delete(sprintTasks).where(eq(sprintTasks.sprintId, sprintId));
        await tx.delete(sprints).where(eq(sprints.id, sprintId));
      });
      return { success: true };
    } catch (error) {
      console.error("Error deleting sprint:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /sprints/:id/tasks
  fastify.post("/sprints/:id/tasks", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: sprintId } = request.params as { id: string };
    try {
      const access = await checkSprintAccess(sprintId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Sprint not found" });

      const body = request.body as Record<string, unknown>;
      const validatedData = addTaskSchema.parse(body);
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, validatedData.taskId),
        with: { list: { with: { space: true } } },
      });
      if (!task) return reply.status(404).send({ error: "Task not found" });
      if (task.list.space.workspaceId !== access.sprint.workspaceId) {
        return reply.status(400).send({ error: "Task must belong to the same workspace as the sprint" });
      }

      const existing = await db.query.sprintTasks.findFirst({
        where: and(eq(sprintTasks.sprintId, sprintId), eq(sprintTasks.taskId, validatedData.taskId)),
      });
      if (existing) return reply.status(400).send({ error: "Task already in sprint" });

      await db.insert(sprintTasks).values({ sprintId, taskId: validatedData.taskId });
      return reply.status(201).send({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error adding task to sprint:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /sprints/:id/burndown
  fastify.get("/sprints/:id/burndown", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: sprintId } = request.params as { id: string };
    try {
      const access = await checkSprintAccess(sprintId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Sprint not found" });

      const sprintTaskRelations = await db.query.sprintTasks.findMany({ where: eq(sprintTasks.sprintId, sprintId) });
      const taskIds = sprintTaskRelations.map(st => st.taskId);
      const totalTasks = taskIds.length;
      if (totalTasks === 0) return { sprint: access.sprint, totalTasks: 0, burndown: [] };

      const startDate = new Date(access.sprint.startDate);
      const endDate = new Date(access.sprint.endDate);

      const completionActivities = await db.select().from(taskActivities).where(
        and(eq(taskActivities.action, "updated"), eq(taskActivities.field, "status"), eq(taskActivities.newValue, "done"),
          inArray(taskActivities.taskId, taskIds), gte(taskActivities.createdAt, startDate), lte(taskActivities.createdAt, endDate))
      ).orderBy(asc(taskActivities.createdAt));

      const completionsByDate = new Map<string, number>();
      const completedTaskIds = new Set<string>();
      for (const activity of completionActivities) {
        if (!completedTaskIds.has(activity.taskId)) {
          completedTaskIds.add(activity.taskId);
          const dateKey = activity.createdAt.toISOString().split("T")[0];
          completionsByDate.set(dateKey, (completionsByDate.get(dateKey) || 0) + 1);
        }
      }

      const burndown: Array<{ date: string; completed: number; remaining: number }> = [];
      const currentDate = new Date(startDate);
      let cumulativeCompleted = 0;
      while (currentDate <= endDate) {
        const dateKey = currentDate.toISOString().split("T")[0];
        cumulativeCompleted += completionsByDate.get(dateKey) || 0;
        burndown.push({ date: dateKey, completed: cumulativeCompleted, remaining: totalTasks - cumulativeCompleted });
        currentDate.setDate(currentDate.getDate() + 1);
      }

      return { sprint: access.sprint, totalTasks, burndown };
    } catch (error) {
      console.error("Error fetching burndown:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /sprints/:id/tasks/:taskId
  fastify.delete("/sprints/:id/tasks/:taskId", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: sprintId, taskId } = request.params as { id: string; taskId: string };
    try {
      const access = await checkSprintAccess(sprintId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Sprint not found" });

      await db.delete(sprintTasks).where(and(eq(sprintTasks.sprintId, sprintId), eq(sprintTasks.taskId, taskId)));
      return { success: true };
    } catch (error) {
      console.error("Error removing task from sprint:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PUT /sprint-tasks (move task between sprints)
  fastify.put("/sprint-tasks", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    try {
      const body = request.body as Record<string, unknown>;
      const { fromSprintId, toSprintId, taskId } = moveTaskSchema.parse(body);

      const fromAccess = await checkSprintAccess(fromSprintId, authResult.userId);
      if (!fromAccess) return reply.status(403).send({ error: "Access denied" });
      const toAccess = await checkSprintAccess(toSprintId, authResult.userId);
      if (!toAccess) return reply.status(403).send({ error: "Access denied to destination sprint" });

      await db.transaction(async (tx) => {
        await tx.delete(sprintTasks).where(and(eq(sprintTasks.sprintId, fromSprintId), eq(sprintTasks.taskId, taskId)));
        await tx.insert(sprintTasks).values({ sprintId: toSprintId, taskId }).onConflictDoNothing();
      });
      return { success: true };
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error moving task between sprints:", error);
      return reply.status(500).send({ error: "Failed to move task" });
    }
  });

  // POST /sprint-tasks
  fastify.post("/sprint-tasks", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    try {
      const { sprintId, taskId } = request.body as { sprintId?: string; taskId?: string };
      if (!sprintId || !taskId) return reply.status(400).send({ error: "Sprint ID and Task ID are required" });

      const access = await checkSprintAccess(sprintId, authResult.userId);
      if (!access) return reply.status(403).send({ error: "Access denied" });

      await db.insert(sprintTasks).values({ sprintId, taskId }).onConflictDoNothing();
      return reply.status(201).send({ success: true });
    } catch (error) {
      console.error("Error adding task to sprint:", error);
      return reply.status(500).send({ error: "Failed to add task to sprint" });
    }
  });

  // DELETE /sprint-tasks
  fastify.delete("/sprint-tasks", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    try {
      const { sprintId, taskId } = request.query as { sprintId?: string; taskId?: string };
      if (!sprintId || !taskId) return reply.status(400).send({ error: "Sprint ID and Task ID are required" });

      const access = await checkSprintAccess(sprintId, authResult.userId);
      if (!access) return reply.status(403).send({ error: "Access denied" });

      await db.delete(sprintTasks).where(and(eq(sprintTasks.sprintId, sprintId), eq(sprintTasks.taskId, taskId)));
      return { success: true };
    } catch (error) {
      console.error("Error removing task from sprint:", error);
      return reply.status(500).send({ error: "Failed to remove task from sprint" });
    }
  });
}
