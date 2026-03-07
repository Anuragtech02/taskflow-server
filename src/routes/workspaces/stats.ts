import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, and, inArray, or, isNull } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { tasks, lists, folders, spaces, workspaceMembers, users } = schema;

export default async function statsRoutes(fastify: FastifyInstance) {
  fastify.get("/workspaces/:id/stats", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId } = request.params as { id: string };

    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const emptyResponse = { totalTasks: 0, completed: 0, inProgress: 0, overdue: 0, byStatus: [], completedOverTime: [], workload: [], recentActivity: [] };

      const workspaceSpaces = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.workspaceId, workspaceId));
      const spaceIds = workspaceSpaces.map(s => s.id);
      if (spaceIds.length === 0) return emptyResponse;

      // Get lists both directly under spaces AND inside folders
      const allLists = await db.select({ id: lists.id }).from(lists)
        .where(inArray(lists.spaceId, spaceIds));
      const listIds = allLists.map(l => l.id);
      if (listIds.length === 0) return emptyResponse;

      const allTasks = await db.select({
        id: tasks.id, status: tasks.status, priority: tasks.priority, dueDate: tasks.dueDate,
        creatorId: tasks.creatorId, createdAt: tasks.createdAt, updatedAt: tasks.updatedAt, title: tasks.title,
      }).from(tasks).where(inArray(tasks.listId, listIds));

      const now = new Date();
      const totalTasks = allTasks.length;
      const completed = allTasks.filter(t => ["done", "closed", "complete"].includes(t.status ?? "")).length;
      const inProgress = allTasks.filter(t => ["in_progress", "in progress"].includes(t.status ?? "")).length;
      const overdue = allTasks.filter(t => t.dueDate && new Date(t.dueDate) < now && !["done", "closed", "complete"].includes(t.status ?? "")).length;

      const statusCounts: Record<string, number> = {};
      allTasks.forEach(t => { const s = t.status || "open"; statusCounts[s] = (statusCounts[s] || 0) + 1; });
      const byStatus = Object.entries(statusCounts).map(([name, count]) => ({ name, count }));

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const completedOverTime: Record<string, number> = {};
      for (let i = 0; i < 30; i++) {
        const d = new Date(); d.setDate(d.getDate() - (29 - i));
        completedOverTime[d.toISOString().split("T")[0]] = 0;
      }
      allTasks.filter(t => ["done", "closed", "complete"].includes(t.status ?? "") && new Date(t.updatedAt) >= thirtyDaysAgo)
        .forEach(t => { const k = new Date(t.updatedAt).toISOString().split("T")[0]; if (completedOverTime[k] !== undefined) completedOverTime[k]++; });

      const workloadMap: Record<string, number> = {};
      allTasks.forEach(t => { const c = t.creatorId || "unknown"; workloadMap[c] = (workloadMap[c] || 0) + 1; });

      const members = await db.select({ userId: workspaceMembers.userId, name: users.name, email: users.email })
        .from(workspaceMembers).leftJoin(users, eq(workspaceMembers.userId, users.id))
        .where(eq(workspaceMembers.workspaceId, workspaceId));
      const memberMap = new Map(members.map(m => [m.userId, m.name || m.email || "Unknown"]));

      const workload = Object.entries(workloadMap).map(([userId, count]) => ({ name: memberMap.get(userId) || "Unknown", tasks: count }));

      const recentActivity = allTasks
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 10)
        .map(t => ({ id: t.id, title: t.title, status: t.status, updatedAt: t.updatedAt, creatorName: memberMap.get(t.creatorId) || "Unknown" }));

      return {
        totalTasks, completed, inProgress, overdue, byStatus,
        completedOverTime: Object.entries(completedOverTime).map(([date, count]) => ({ date, count })),
        workload, recentActivity,
      };
    } catch (error) {
      console.error("Error fetching workspace stats:", error);
      return reply.status(500).send({ error: "Failed to fetch stats" });
    }
  });
}
