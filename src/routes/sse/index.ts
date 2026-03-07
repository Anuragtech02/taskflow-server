import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, and } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";
import { config } from "../../config.js";

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

    // Derive CORS origin the same way the cors plugin does
    const origin = request.headers.origin;
    const allowedOrigin = config.corsOrigin;
    const mainDomain = config.mainDomain;
    let corsOrigin = allowedOrigin;
    if (origin) {
      if (origin === allowedOrigin || (mainDomain && origin.endsWith(`.${mainDomain}`))) {
        corsOrigin = origin;
      }
      try {
        const url = new URL(origin);
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
          corsOrigin = origin;
        }
      } catch {}
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Credentials": "true",
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
