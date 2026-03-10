import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, and, inArray } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";
import { config } from "../../config.js";

const { workspaceMembers, users } = schema;

async function getActiveUserDetails(fastify: FastifyInstance, workspaceId: string) {
  const userIds = fastify.sse.getActiveUsers(workspaceId);
  if (userIds.length === 0) return [];
  const activeUsers = await db
    .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
    .from(users)
    .where(inArray(users.id, userIds));
  return activeUsers;
}

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

    // Tell Fastify to stop managing the response — we're taking over reply.raw
    reply.hijack();

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Credentials": "true",
    });

    // Send initial connection
    const connectedPayload = JSON.stringify({ userId: authResult.userId, workspaceId: workspaceId || "" });
    reply.raw.write(`event: connected\ndata: ${connectedPayload}\n\n`);

    // Register with SSE plugin
    if (workspaceId) {
      fastify.sse.addConnection(workspaceId, reply.raw, authResult.userId);

      // Broadcast presence update to all connections in the workspace
      const activeUsers = await getActiveUserDetails(fastify, workspaceId);
      fastify.sse.broadcastToWorkspace(workspaceId, {
        type: "presence_update",
        data: { activeUsers },
      });
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

        // Broadcast updated presence after disconnect
        getActiveUserDetails(fastify, workspaceId).then((activeUsers) => {
          fastify.sse.broadcastToWorkspace(workspaceId, {
            type: "presence_update",
            data: { activeUsers },
          });
        }).catch(() => {});
      }
      try { reply.raw.end(); } catch {}
    });
  });

  // GET /sse/presence
  fastify.get("/sse/presence", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send("Unauthorized");

    const { workspaceId } = request.query as { workspaceId?: string };
    if (!workspaceId) return reply.status(400).send("workspaceId query param required");

    const membership = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
    });
    if (!membership) return reply.status(403).send("Forbidden");

    const activeUsers = await getActiveUserDetails(fastify, workspaceId);
    return reply.send({ activeUsers });
  });
}
