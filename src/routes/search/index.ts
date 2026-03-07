import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { and, ilike, eq, inArray } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { tasks, documents, workspaceMembers, spaces, lists } = schema;

export default async function searchRoutes(fastify: FastifyInstance) {
  // GET /search
  fastify.get("/search", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { q: query, workspaceId } = request.query as { q?: string; workspaceId?: string };
    if (!query || query.trim().length === 0) return { results: [] };

    const searchPattern = `%${query}%`;

    const userWorkspaces = await db.select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers).where(eq(workspaceMembers.userId, authResult.userId));
    const workspaceIds = userWorkspaces.map(w => w.workspaceId);
    if (workspaceIds.length === 0) return { results: [] };

    if (workspaceId && !workspaceIds.includes(workspaceId)) return reply.status(403).send({ error: "Access denied" });
    const targetWorkspaceIds = workspaceId ? [workspaceId] : workspaceIds;

    const taskResults = await db.select({ id: tasks.id, title: tasks.title, listId: tasks.listId, workspaceId: spaces.workspaceId })
      .from(tasks).innerJoin(lists, eq(tasks.listId, lists.id)).innerJoin(spaces, eq(lists.spaceId, spaces.id))
      .where(and(ilike(tasks.title, searchPattern), inArray(spaces.workspaceId, targetWorkspaceIds))).limit(10);

    const docResults = await db.select({ id: documents.id, title: documents.title, workspaceId: documents.workspaceId })
      .from(documents).where(and(ilike(documents.title, searchPattern), inArray(documents.workspaceId, targetWorkspaceIds))).limit(10);

    return {
      results: [
        ...taskResults.map(t => ({ id: t.id, title: t.title, type: "task" as const, workspaceId: t.workspaceId, url: `/dashboard/workspaces/${t.workspaceId}/tasks/${t.id}` })),
        ...docResults.map(d => ({ id: d.id, title: d.title, type: "doc" as const, workspaceId: d.workspaceId, url: `/dashboard/workspaces/${d.workspaceId}/docs/${d.id}` })),
      ],
    };
  });
}
