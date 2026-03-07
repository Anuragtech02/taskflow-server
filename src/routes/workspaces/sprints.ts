import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and, asc } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { sprints, workspaceMembers } = schema;

const createSprintSchema = z.object({
  name: z.string().min(1).max(255),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  goal: z.string().optional(),
});

export default async function workspaceSprintRoutes(fastify: FastifyInstance) {
  // GET /workspaces/:id/sprints
  fastify.get("/workspaces/:id/sprints", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });
      const workspaceSprints = await db.query.sprints.findMany({
        where: eq(sprints.workspaceId, workspaceId), orderBy: [asc(sprints.startDate)],
      });
      return { sprints: workspaceSprints };
    } catch (error) {
      console.error("Error fetching sprints:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /workspaces/:id/sprints
  fastify.post("/workspaces/:id/sprints", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership || !["owner", "admin"].includes(membership.role)) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const validatedData = createSprintSchema.parse(body);
      const [sprint] = await db.insert(sprints).values({
        workspaceId, name: validatedData.name,
        startDate: new Date(validatedData.startDate), endDate: new Date(validatedData.endDate),
        goal: validatedData.goal || null,
      }).returning();
      return reply.status(201).send({ sprint });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating sprint:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
