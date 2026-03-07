import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, and } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { workspaceMembers } = schema;

export default async function sseRoutes(fastify: FastifyInstance) {
  // GET /sse
  fastify.get("/sse", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send("Unauthorized");

    const { workspaceId } = request.query as { workspaceId?: string };

    if (workspaceId) {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send("Forbidden");
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send initial connection
    reply.raw.write(`event: connected\ndata: {"userId":"${authResult.userId}","workspaceId":"${workspaceId || ""}"}\n\n`);

    // Register with SSE plugin
    if (workspaceId) {
      fastify.sse.addConnection(workspaceId, reply.raw);
    }

    // Keepalive
    const interval = setInterval(() => {
      try { reply.raw.write(`: keepalive\n\n`); } catch { clearInterval(interval); }
    }, 30000);

    // Cleanup on close
    request.raw.on("close", () => {
      clearInterval(interval);
      if (workspaceId) {
        fastify.sse.removeConnection(workspaceId, reply.raw);
      }
      try { reply.raw.end(); } catch {}
    });
  });
}
