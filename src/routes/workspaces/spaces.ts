import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { spaces, workspaceMembers } = schema;

const createSpaceSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().optional(),
  order: z.number().optional(),
});

export default async function workspaceSpaceRoutes(fastify: FastifyInstance) {
  // GET /workspaces/:id/spaces
  fastify.get("/workspaces/:id/spaces", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const workspaceSpaces = await db.select().from(spaces).where(eq(spaces.workspaceId, workspaceId)).orderBy(spaces.order);
      return { spaces: workspaceSpaces };
    } catch (error) {
      console.error("Error fetching spaces:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /workspaces/:id/spaces
  fastify.post("/workspaces/:id/spaces", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const validatedData = createSpaceSchema.parse(body);

      const [space] = await db.insert(spaces).values({
        workspaceId, name: validatedData.name, description: validatedData.description,
        color: validatedData.color, icon: validatedData.icon, order: validatedData.order ?? 0,
      }).returning();

      return reply.status(201).send({ space });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating space:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
