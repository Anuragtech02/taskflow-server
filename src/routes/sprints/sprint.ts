import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and, asc, desc, gte, lte, inArray } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../../config.js";

const { sprints, workspaceMembers, sprintTasks, tasks, taskActivities, sprintRetroItems, users, lists } = schema;

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
      if (access.sprint.spaceId && task.list.spaceId !== access.sprint.spaceId) {
        return reply.status(400).send({ error: "Task must belong to the same space as the sprint" });
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

  // ==================== RETROSPECTIVE ====================

  const createRetroItemSchema = z.object({
    category: z.enum(["went_well", "to_improve", "action_item"]),
    content: z.string().min(1).max(2000),
  });

  // GET /sprints/:id/retro
  fastify.get("/sprints/:id/retro", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: sprintId } = request.params as { id: string };
    try {
      const access = await checkSprintAccess(sprintId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Sprint not found" });

      const items = await db.query.sprintRetroItems.findMany({
        where: eq(sprintRetroItems.sprintId, sprintId),
        with: { user: { columns: { id: true, name: true, avatarUrl: true } } },
        orderBy: [asc(sprintRetroItems.createdAt)],
      });

      // Sprint summary stats
      const sprintTaskRelations = await db.query.sprintTasks.findMany({
        where: eq(sprintTasks.sprintId, sprintId),
        with: {
          task: {
            with: {
              assignees: { with: { user: { columns: { id: true, name: true, avatarUrl: true } } } },
            },
          },
        },
      });

      const allTasks = sprintTaskRelations.map(st => st.task);
      const completed = allTasks.filter(t => t.status === "done" || t.status === "closed" || t.status === "complete");
      const carriedOver = allTasks.filter(t => t.status !== "done" && t.status !== "closed" && t.status !== "complete");

      // Tasks per assignee
      const byAssignee: Record<string, { user: { id: string; name: string | null; avatarUrl: string | null }; completed: number; total: number }> = {};
      for (const task of allTasks) {
        for (const a of task.assignees) {
          if (!byAssignee[a.user.id]) {
            byAssignee[a.user.id] = { user: a.user, completed: 0, total: 0 };
          }
          byAssignee[a.user.id].total++;
          if (completed.some(c => c.id === task.id)) {
            byAssignee[a.user.id].completed++;
          }
        }
      }

      return {
        items,
        summary: {
          totalTasks: allTasks.length,
          completedTasks: completed.length,
          carriedOverTasks: carriedOver.length,
          completionRate: allTasks.length > 0 ? Math.round((completed.length / allTasks.length) * 100) : 0,
          byAssignee: Object.values(byAssignee),
        },
      };
    } catch (error) {
      console.error("Error fetching retro:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /sprints/:id/retro
  fastify.post("/sprints/:id/retro", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: sprintId } = request.params as { id: string };
    try {
      const access = await checkSprintAccess(sprintId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Sprint not found" });

      const body = request.body as Record<string, unknown>;
      const validatedData = createRetroItemSchema.parse(body);

      const [item] = await db.insert(sprintRetroItems).values({
        sprintId,
        userId: authResult.userId,
        category: validatedData.category,
        content: validatedData.content,
      }).returning();

      const itemWithUser = await db.query.sprintRetroItems.findFirst({
        where: eq(sprintRetroItems.id, item.id),
        with: { user: { columns: { id: true, name: true, avatarUrl: true } } },
      });

      return reply.status(201).send({ item: itemWithUser });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating retro item:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /sprints/:id/retro/:itemId
  fastify.delete("/sprints/:id/retro/:itemId", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: sprintId, itemId } = request.params as { id: string; itemId: string };
    try {
      const access = await checkSprintAccess(sprintId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Sprint not found" });

      const item = await db.query.sprintRetroItems.findFirst({
        where: and(eq(sprintRetroItems.id, itemId), eq(sprintRetroItems.sprintId, sprintId)),
      });
      if (!item) return reply.status(404).send({ error: "Retro item not found" });
      // Only the author or workspace admin/owner can delete
      if (item.userId !== authResult.userId && !["owner", "admin"].includes(access.membership.role)) {
        return reply.status(403).send({ error: "Not authorized to delete this item" });
      }

      await db.delete(sprintRetroItems).where(eq(sprintRetroItems.id, itemId));
      return { success: true };
    } catch (error) {
      console.error("Error deleting retro item:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /sprints/:id/retro/:itemId/convert-to-task
  fastify.post("/sprints/:id/retro/:itemId/convert-to-task", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: sprintId, itemId } = request.params as { id: string; itemId: string };
    try {
      const access = await checkSprintAccess(sprintId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Sprint not found" });

      const item = await db.query.sprintRetroItems.findFirst({
        where: and(eq(sprintRetroItems.id, itemId), eq(sprintRetroItems.sprintId, sprintId)),
      });
      if (!item) return reply.status(404).send({ error: "Retro item not found" });
      if (item.convertedTaskId) return reply.status(400).send({ error: "Already converted to a task" });

      // Get the listId from the request body, or find the first list in the sprint's space
      const body = request.body as { listId?: string };
      let listId = body.listId;
      if (!listId) {
        const spaceLists = await db.select({ id: lists.id }).from(lists)
          .where(eq(lists.spaceId, access.sprint.spaceId))
          .limit(1);
        if (spaceLists.length === 0) return reply.status(400).send({ error: "No lists found in space. Provide a listId." });
        listId = spaceLists[0].id;
      }

      // Create the task
      const [task] = await db.insert(tasks).values({
        listId,
        title: item.content.substring(0, 500),
        status: "todo",
        priority: "medium",
        creatorId: authResult.userId,
      }).returning();

      // Link the retro item to the task
      await db.update(sprintRetroItems).set({ convertedTaskId: task.id }).where(eq(sprintRetroItems.id, itemId));

      // If there's a next planned/active sprint in the same space, add the task to it
      const nextSprint = await db.query.sprints.findFirst({
        where: and(
          eq(sprints.spaceId, access.sprint.spaceId),
          inArray(sprints.status, ["planned", "active"]),
        ),
        orderBy: [asc(sprints.startDate)],
      });
      if (nextSprint) {
        await db.insert(sprintTasks).values({ sprintId: nextSprint.id, taskId: task.id }).onConflictDoNothing();
      }

      return reply.status(201).send({ task, addedToSprintId: nextSprint?.id || null });
    } catch (error) {
      console.error("Error converting retro item to task:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ==================== AI SPRINT ANALYSIS ====================

  // POST /sprints/:id/analyze
  fastify.post("/sprints/:id/analyze", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: sprintId } = request.params as { id: string };
    try {
      const access = await checkSprintAccess(sprintId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Sprint not found" });

      if (!config.geminiApiKey) return reply.status(500).send({ error: "AI analysis not configured" });

      // Fetch sprint tasks with details
      const sprintTaskRelations = await db.query.sprintTasks.findMany({
        where: eq(sprintTasks.sprintId, sprintId),
        with: {
          task: {
            with: {
              assignees: { with: { user: { columns: { id: true, name: true } } } },
              creator: { columns: { id: true, name: true } },
              list: { columns: { id: true, name: true } },
            },
          },
        },
      });

      const sprintTasksList = sprintTaskRelations.map(st => st.task);
      const taskIds = sprintTasksList.map(t => t.id);

      if (taskIds.length === 0) return reply.status(400).send({ error: "No tasks in this sprint to analyze" });

      // Fetch ALL activities for these tasks
      const activities = await db.query.taskActivities.findMany({
        where: inArray(taskActivities.taskId, taskIds),
        with: { user: { columns: { id: true, name: true } } },
        orderBy: [asc(taskActivities.createdAt)],
      });

      // Build per-task analysis data
      const taskAnalysis = sprintTasksList.map(task => {
        const taskActs = activities.filter(a => a.taskId === task.id);
        const statusChanges = taskActs.filter(a => a.action === "updated" && a.field === "status");

        // Compute cycle times from status transitions
        const transitions: { from: string; to: string; at: string }[] = [];
        for (const sc of statusChanges) {
          transitions.push({
            from: sc.oldValue || "unknown",
            to: sc.newValue || "unknown",
            at: sc.createdAt.toISOString(),
          });
        }

        // Count rework: how many times task went backwards (done/review → in_progress/todo)
        const backwardStatuses = ["todo", "in_progress"];
        const forwardStatuses = ["in_review", "review", "done", "closed", "complete"];
        let reworkCount = 0;
        for (const sc of statusChanges) {
          if (forwardStatuses.includes(sc.oldValue || "") && backwardStatuses.includes(sc.newValue || "")) {
            reworkCount++;
          }
        }

        // Time in each status
        const statusDurations: Record<string, number> = {};
        let lastStatus = task.status || "todo";
        let lastTime = task.createdAt;
        for (const sc of statusChanges) {
          const duration = sc.createdAt.getTime() - lastTime.getTime();
          const statusKey = sc.oldValue || lastStatus;
          statusDurations[statusKey] = (statusDurations[statusKey] || 0) + duration;
          lastStatus = sc.newValue || lastStatus;
          lastTime = sc.createdAt;
        }
        // Add time in current status up to now
        const now = new Date();
        statusDurations[lastStatus] = (statusDurations[lastStatus] || 0) + (now.getTime() - lastTime.getTime());

        // Format durations as hours
        const statusDurationsHours: Record<string, number> = {};
        for (const [status, ms] of Object.entries(statusDurations)) {
          statusDurationsHours[status] = Math.round((ms / (1000 * 60 * 60)) * 10) / 10;
        }

        const commentCount = taskActs.filter(a => a.action === "added_comment").length;
        const assigneeChanges = taskActs.filter(a => a.action === "added_assignee" || a.action === "removed_assignee").length;

        return {
          title: task.title,
          status: task.status,
          priority: task.priority,
          assignees: task.assignees.map(a => a.user.name).join(", ") || "Unassigned",
          list: task.list?.name || "Unknown",
          timeEstimateHours: task.timeEstimate ? Math.round(task.timeEstimate / 60) : null,
          timeSpentHours: task.timeSpent ? Math.round(task.timeSpent / 60) : null,
          statusTransitions: transitions,
          statusDurationsHours,
          reworkCount,
          commentCount,
          assigneeChanges,
          totalStatusChanges: statusChanges.length,
          createdAt: task.createdAt.toISOString(),
        };
      });

      // Build the prompt
      const sprint = access.sprint;
      const prompt = `You are a senior engineering manager conducting a sprint retrospective analysis. Analyze the following sprint data and provide actionable insights.

## Sprint: "${sprint.name}"
- **Duration**: ${new Date(sprint.startDate).toLocaleDateString()} to ${new Date(sprint.endDate).toLocaleDateString()}
- **Goal**: ${sprint.goal || "No goal set"}
- **Total Tasks**: ${taskAnalysis.length}
- **Completed**: ${taskAnalysis.filter(t => t.status === "done" || t.status === "closed" || t.status === "complete").length}
- **Incomplete**: ${taskAnalysis.filter(t => t.status !== "done" && t.status !== "closed" && t.status !== "complete").length}

## Task-Level Data:
${taskAnalysis.map((t, i) => `
### Task ${i + 1}: "${t.title}"
- Status: ${t.status} | Priority: ${t.priority} | Assignees: ${t.assignees} | List: ${t.list}
- Time estimate: ${t.timeEstimateHours ? t.timeEstimateHours + "h" : "None"} | Time spent: ${t.timeSpentHours ? t.timeSpentHours + "h" : "None"}
- Status changes: ${t.totalStatusChanges} | Rework count (sent back): ${t.reworkCount} | Comments: ${t.commentCount}
- Time per status (hours): ${JSON.stringify(t.statusDurationsHours)}
- Transitions: ${t.statusTransitions.map(tr => `${tr.from}→${tr.to} at ${new Date(tr.at).toLocaleDateString()}`).join(", ") || "None"}
`).join("")}

## Analysis Instructions:
Provide a structured analysis in markdown format with these sections:

### 🏁 Sprint Overview
A 2-3 sentence summary of how the sprint went overall.

### ⏱️ Cycle Time Analysis
- Which tasks took the longest to move from todo → in progress → done?
- Where did tasks get stuck the most (which status had the longest duration)?
- Are there bottlenecks in the workflow?

### 🔄 Rework & Quality Issues
- Which tasks were sent back (rework) and how many times?
- What patterns do you see in tasks that needed rework?
- Any tasks that bounced between statuses repeatedly?

### 🎯 Impact & Priority Analysis
- Were high-priority tasks completed on time?
- Were there mismatches between priority and actual effort spent?
- Which tasks had the most activity (comments, assignee changes)?

### 👥 Team Workload
- How was work distributed across team members?
- Were there any overloaded individuals?

### 💡 Recommendations
- 3-5 specific, actionable recommendations for the next sprint based on the data.

Keep the analysis data-driven and reference specific tasks by name. Be concise but insightful. Do not use generic advice — base everything on the actual data provided.`;

      const genAI = new GoogleGenerativeAI(config.geminiApiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContent(prompt);
      const summary = result.response.text();

      // Store the analysis
      await db.update(sprints).set({
        aiSummary: summary,
        aiSummaryGeneratedAt: new Date(),
      }).where(eq(sprints.id, sprintId));

      return { summary, generatedAt: new Date().toISOString() };
    } catch (error) {
      console.error("Error generating sprint analysis:", error);
      return reply.status(500).send({ error: "Failed to generate AI analysis" });
    }
  });

  // GET /sprints/:id/analyze
  fastify.get("/sprints/:id/analyze", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: sprintId } = request.params as { id: string };
    try {
      const access = await checkSprintAccess(sprintId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Sprint not found" });

      return {
        summary: access.sprint.aiSummary || null,
        generatedAt: access.sprint.aiSummaryGeneratedAt?.toISOString() || null,
      };
    } catch (error) {
      console.error("Error fetching sprint analysis:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
