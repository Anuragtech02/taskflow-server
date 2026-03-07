import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, and, ilike, or, sql, inArray } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { tasks, taskComments, documents, lists, spaces, workspaceMembers } = schema;

export default async function workspaceSearchRoutes(fastify: FastifyInstance) {
  // GET /workspaces/:id/search?q=searchterm
  fastify.get("/workspaces/:id/search", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId } = request.params as { id: string };
    const { q: query } = request.query as { q?: string };

    if (!query || query.length < 2) {
      return reply.status(400).send({ error: "Search query too short (min 2 chars)" });
    }

    try {
      const memberCheck = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!memberCheck) return reply.status(403).send({ error: "Access denied" });

      const workspaceSpaces = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.workspaceId, workspaceId));
      const spaceIds = workspaceSpaces.map(s => s.id);

      let listIds: string[] = [];
      if (spaceIds.length > 0) {
        const workspaceLists = await db.select({ id: lists.id }).from(lists).where(inArray(lists.spaceId, spaceIds));
        listIds = workspaceLists.map(l => l.id);
      }

      const searchPattern = `%${query}%`;

      let taskResults: any[] = [];
      if (listIds.length > 0) {
        taskResults = await db.select({
          id: tasks.id, title: tasks.title, status: tasks.status,
          priority: tasks.priority, dueDate: tasks.dueDate, listId: tasks.listId,
        }).from(tasks).where(and(
          inArray(tasks.listId, listIds),
          or(
            sql`to_tsvector('english', ${tasks.title}) @@ plainto_tsquery('english', ${query})`,
            ilike(tasks.title, searchPattern),
            sql`${tasks.description}::text ILIKE ${searchPattern}`
          )
        )).limit(20);
      }

      let commentResults: any[] = [];
      if (listIds.length > 0) {
        commentResults = await db.select({
          id: taskComments.id, taskId: taskComments.taskId, content: taskComments.content, createdAt: taskComments.createdAt,
        }).from(taskComments).innerJoin(tasks, eq(taskComments.taskId, tasks.id)).where(and(
          inArray(tasks.listId, listIds),
          or(
            sql`to_tsvector('english', ${taskComments.content}) @@ plainto_tsquery('english', ${query})`,
            ilike(taskComments.content, searchPattern)
          )
        )).limit(10);
      }

      const docResults = await db.select({
        id: documents.id, title: documents.title, icon: documents.icon, updatedAt: documents.updatedAt,
      }).from(documents).where(and(
        eq(documents.workspaceId, workspaceId),
        or(
          sql`to_tsvector('english', ${documents.title}) @@ plainto_tsquery('english', ${query})`,
          ilike(documents.title, searchPattern),
          sql`${documents.content}::text ILIKE ${searchPattern}`
        )
      )).limit(20);

      const results = {
        tasks: taskResults.map(t => ({ ...t, type: "task" as const })),
        comments: commentResults.map(c => ({ id: c.id, taskId: c.taskId, content: c.content.substring(0, 200), createdAt: c.createdAt, type: "comment" as const })),
        documents: docResults.map(d => ({ ...d, type: "document" as const })),
      };

      return { results, query, total: results.tasks.length + results.comments.length + results.documents.length };
    } catch (error) {
      console.error("Error searching:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
