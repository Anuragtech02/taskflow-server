import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, and, inArray, sql, desc } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { tasks, workspaceMembers, lists, spaces, sprints, sprintTasks, taskAssignees } = schema;

export default async function dashboardRoutes(fastify: FastifyInstance) {
  fastify.get("/workspaces/:id/dashboard", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId } = request.params as { id: string };

    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const workspaceSpaces = await db.query.spaces.findMany({ where: eq(spaces.workspaceId, workspaceId) });
      const spaceIds = workspaceSpaces.map(s => s.id);

      let listIds: string[] = [];
      if (spaceIds.length > 0) {
        const workspaceLists = await db.query.lists.findMany({ where: inArray(lists.spaceId, spaceIds) });
        listIds = workspaceLists.map(l => l.id);
      }

      let workspaceTasks: typeof tasks.$inferSelect[] = [];
      if (listIds.length > 0) {
        workspaceTasks = await db.query.tasks.findMany({ where: inArray(tasks.listId, listIds), limit: 5000 });
      }

      const now = new Date();
      const totalTasks = workspaceTasks.length;
      const completedTasks = workspaceTasks.filter(t => t.status === "done" || t.status === "completed").length;
      const inProgressTasks = workspaceTasks.filter(t => t.status === "in_progress").length;
      const overdueTasks = workspaceTasks.filter(t => t.dueDate && new Date(t.dueDate) < now && t.status !== "done" && t.status !== "completed");

      const tasksByStatus = {
        todo: workspaceTasks.filter(t => t.status === "todo").length,
        in_progress: workspaceTasks.filter(t => t.status === "in_progress").length,
        in_review: workspaceTasks.filter(t => t.status === "in_review").length,
        done: workspaceTasks.filter(t => t.status === "done" || t.status === "completed").length,
      };

      const tasksByPriority = {
        urgent: workspaceTasks.filter(t => t.priority === "urgent").length,
        high: workspaceTasks.filter(t => t.priority === "high").length,
        medium: workspaceTasks.filter(t => t.priority === "medium").length,
        low: workspaceTasks.filter(t => t.priority === "low").length,
        none: workspaceTasks.filter(t => t.priority === "none").length,
      };

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      let completedActivities: typeof tasks.$inferSelect[] = [];
      if (listIds.length > 0) {
        completedActivities = await db.select().from(tasks).where(and(
          inArray(tasks.listId, listIds),
          sql`${tasks.status} IN ('done', 'completed')`,
          sql`${tasks.updatedAt} >= ${thirtyDaysAgo.toISOString()}`
        )).orderBy(desc(tasks.updatedAt));
      }

      const completedByDay = new Map<string, number>();
      for (const task of completedActivities) {
        const dateKey = task.updatedAt.toISOString().split("T")[0];
        completedByDay.set(dateKey, (completedByDay.get(dateKey) || 0) + 1);
      }
      const tasksCompletedPerDay = Array.from(completedByDay).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));

      const workspaceSprints = await db.query.sprints.findMany({
        where: eq(sprints.workspaceId, workspaceId), orderBy: [desc(sprints.startDate)], limit: 10,
      });

      const sprintVelocity: Array<{ sprintId: string; sprintName: string; completedTasks: number }> = [];
      for (const sprint of workspaceSprints) {
        const sprintTaskRelations = await db.query.sprintTasks.findMany({ where: eq(sprintTasks.sprintId, sprint.id) });
        const sprintTaskIds = sprintTaskRelations.map(st => st.taskId);
        if (sprintTaskIds.length > 0) {
          const completedInSprint = await db.select({ count: sql<number>`count(*)` }).from(tasks)
            .where(and(inArray(tasks.id, sprintTaskIds), sql`${tasks.status} IN ('done', 'completed')`));
          sprintVelocity.push({ sprintId: sprint.id, sprintName: sprint.name, completedTasks: completedInSprint[0]?.count || 0 });
        } else {
          sprintVelocity.push({ sprintId: sprint.id, sprintName: sprint.name, completedTasks: 0 });
        }
      }

      const allTaskAssignees = workspaceTasks.length > 0 ? await db.query.taskAssignees.findMany({
        where: inArray(taskAssignees.taskId, workspaceTasks.map(t => t.id)),
        with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } },
      }) : [];

      const workloadByUser = new Map<string, { userId: string; name: string; avatarUrl: string | null; total: number; completed: number }>();
      for (const assignee of allTaskAssignees) {
        const userId = assignee.user.id;
        if (!workloadByUser.has(userId)) {
          const userTasks = workspaceTasks.filter(t => allTaskAssignees.some(a => a.userId === userId && a.taskId === t.id));
          workloadByUser.set(userId, {
            userId, name: assignee.user.name, avatarUrl: assignee.user.avatarUrl,
            total: userTasks.length, completed: userTasks.filter(t => t.status === "done" || t.status === "completed").length,
          });
        }
      }

      const overdueTasksList = overdueTasks.map(t => ({
        id: t.id, title: t.title, status: t.status, priority: t.priority,
        dueDate: t.dueDate?.toISOString?.() || t.dueDate, listId: t.listId,
        createdAt: t.createdAt?.toISOString?.() || t.createdAt, updatedAt: t.updatedAt?.toISOString?.() || t.updatedAt,
      }));

      const serializedWorkspaceTasks = workspaceTasks.map(t => ({
        ...t, createdAt: t.createdAt?.toISOString?.() || t.createdAt,
        updatedAt: t.updatedAt?.toISOString?.() || t.updatedAt, dueDate: t.dueDate?.toISOString?.() || t.dueDate,
      }));

      return {
        stats: { totalTasks, completed: completedTasks, inProgress: inProgressTasks, overdue: overdueTasks.length },
        tasksByStatus, tasksByPriority, tasksCompletedPerDay, sprintVelocity,
        workloadPerAssignee: Array.from(workloadByUser.values()),
        overdueTasks: overdueTasksList, recentTasks: serializedWorkspaceTasks.slice(0, 20),
      };
    } catch (error) {
      console.error("Error fetching dashboard:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
