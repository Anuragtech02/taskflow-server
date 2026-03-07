import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, and, sql, between, inArray } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { tasks, taskAssignees, timeEntries, lists, spaces, users, workspaceMembers } = schema;

export default async function reportRoutes(fastify: FastifyInstance) {
  // GET /workspaces/:id/reports/time
  fastify.get("/workspaces/:id/reports/time", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const { startDate, endDate, userId, taskId } = request.query as {
        startDate?: string; endDate?: string; userId?: string; taskId?: string;
      };

      const workspaceSpaces = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.workspaceId, workspaceId));
      const spaceIds = workspaceSpaces.map(s => s.id);
      let listIds: string[] = [];
      if (spaceIds.length > 0) {
        const workspaceLists = await db.select({ id: lists.id }).from(lists).where(inArray(lists.spaceId, spaceIds));
        listIds = workspaceLists.map(l => l.id);
      }
      if (listIds.length === 0) {
        return { entries: [], byUser: [], byTask: [], summary: { totalMinutes: 0, entryCount: 0 } };
      }

      const whereConditions: any[] = [inArray(tasks.listId, listIds)];
      if (startDate && endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);
        whereConditions.push(between(timeEntries.startTime, start, end));
      }
      if (userId) whereConditions.push(eq(timeEntries.userId, userId));
      if (taskId) whereConditions.push(eq(timeEntries.taskId, taskId));
      const whereClause = and(...whereConditions);

      const entries = await db.select({
        id: timeEntries.id, taskId: timeEntries.taskId, userId: timeEntries.userId,
        startTime: timeEntries.startTime, endTime: timeEntries.endTime, duration: timeEntries.duration,
        description: timeEntries.description, taskTitle: tasks.title, userName: users.name,
      }).from(timeEntries).innerJoin(tasks, eq(timeEntries.taskId, tasks.id))
        .innerJoin(users, eq(timeEntries.userId, users.id)).where(whereClause)
        .orderBy(sql`${timeEntries.startTime} DESC`).limit(500);

      const userAggregation = await db.select({
        userId: timeEntries.userId, userName: users.name,
        totalDuration: sql<number>`COALESCE(SUM(${timeEntries.duration}), 0)::int`,
        entryCount: sql<number>`COUNT(*)::int`,
      }).from(timeEntries).innerJoin(tasks, eq(timeEntries.taskId, tasks.id))
        .innerJoin(users, eq(timeEntries.userId, users.id)).where(whereClause)
        .groupBy(timeEntries.userId, users.name);

      const taskAggregation = await db.select({
        taskId: tasks.id, taskTitle: tasks.title,
        totalDuration: sql<number>`COALESCE(SUM(${timeEntries.duration}), 0)::int`,
        entryCount: sql<number>`COUNT(*)::int`,
      }).from(timeEntries).innerJoin(tasks, eq(timeEntries.taskId, tasks.id)).where(whereClause)
        .groupBy(tasks.id, tasks.title);

      const summary = await db.select({
        totalDuration: sql<number>`COALESCE(SUM(${timeEntries.duration}), 0)::int`,
        entryCount: sql<number>`COUNT(*)::int`,
      }).from(timeEntries).innerJoin(tasks, eq(timeEntries.taskId, tasks.id)).where(whereClause);

      return {
        entries: entries.map(e => ({ id: e.id, taskId: e.taskId, taskTitle: e.taskTitle, userId: e.userId, userName: e.userName, startTime: e.startTime, endTime: e.endTime, duration: e.duration, description: e.description })),
        byUser: userAggregation.map(u => ({ userId: u.userId, userName: u.userName, totalMinutes: u.totalDuration, entryCount: u.entryCount })),
        byTask: taskAggregation.map(t => ({ taskId: t.taskId, taskTitle: t.taskTitle, totalMinutes: t.totalDuration, entryCount: t.entryCount })),
        summary: { totalMinutes: summary[0]?.totalDuration || 0, entryCount: summary[0]?.entryCount || 0 },
      };
    } catch (error) {
      console.error("Error fetching time report:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /workspaces/:id/reports/workload
  fastify.get("/workspaces/:id/reports/workload", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const workspaceSpaces = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.workspaceId, workspaceId));
      const spaceIds = workspaceSpaces.map(s => s.id);
      let listIds: string[] = [];
      if (spaceIds.length > 0) {
        const workspaceLists = await db.select({ id: lists.id }).from(lists).where(inArray(lists.spaceId, spaceIds));
        listIds = workspaceLists.map(l => l.id);
      }

      const members = await db.query.workspaceMembers.findMany({
        where: eq(workspaceMembers.workspaceId, workspaceId), with: { user: true },
      });

      const workloadData = [];
      for (const member of members) {
        if (listIds.length === 0) {
          workloadData.push({
            user: { id: member.user.id, name: member.user.name, email: member.user.email, avatarUrl: member.user.avatarUrl },
            tasks: { total: 0, byStatus: {} }, time: { totalMinutes: 0 },
          });
          continue;
        }

        const taskStats = await db.select({ status: tasks.status, count: sql<number>`count(*)::int` })
          .from(tasks).innerJoin(taskAssignees, eq(tasks.id, taskAssignees.taskId))
          .where(and(eq(taskAssignees.userId, member.userId), inArray(tasks.listId, listIds)))
          .groupBy(tasks.status);

        const timeResult = await db.select({ totalTime: sql<number>`COALESCE(SUM(${timeEntries.duration}), 0)::int` })
          .from(timeEntries).innerJoin(tasks, eq(timeEntries.taskId, tasks.id))
          .where(and(eq(timeEntries.userId, member.userId), inArray(tasks.listId, listIds)));

        workloadData.push({
          user: { id: member.user.id, name: member.user.name, email: member.user.email, avatarUrl: member.user.avatarUrl },
          tasks: {
            total: taskStats.reduce((sum, s) => sum + s.count, 0),
            byStatus: taskStats.reduce((acc, s) => { acc[s.status ?? "unknown"] = s.count; return acc; }, {} as Record<string, number>),
          },
          time: { totalMinutes: timeResult[0]?.totalTime || 0 },
        });
      }
      return { workload: workloadData };
    } catch (error) {
      console.error("Error fetching workload:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
