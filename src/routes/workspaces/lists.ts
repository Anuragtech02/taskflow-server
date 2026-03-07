import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, and } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { spaces, folders, lists, workspaceMembers } = schema;

export default async function workspaceListRoutes(fastify: FastifyInstance) {
  // GET /workspaces/:id/lists
  fastify.get("/workspaces/:id/lists", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const workspaceSpaces = await db.query.spaces.findMany({
        where: eq(spaces.workspaceId, workspaceId),
        orderBy: spaces.order,
        with: {
          folders: { orderBy: folders.order, with: { lists: { orderBy: lists.order } } },
          lists: { orderBy: lists.order },
        },
      });

      const result = workspaceSpaces.map(space => ({
        id: space.id, name: space.name,
        lists: space.lists.filter(l => !l.folderId).map(l => ({ id: l.id, name: l.name })),
        folders: space.folders.map(folder => ({
          id: folder.id, name: folder.name,
          lists: folder.lists.map(l => ({ id: l.id, name: l.name })),
        })),
      }));
      return { spaces: result };
    } catch (error) {
      console.error("Error fetching workspace lists:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
