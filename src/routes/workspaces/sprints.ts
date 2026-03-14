import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and, asc } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { sprints, spaces, workspaceMembers } = schema;

const createSprintSchema = z.object({
  name: z.string().min(1).max(255),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  goal: z.string().optional(),
});

export default async function workspaceSprintRoutes(fastify: FastifyInstance) {
  // GET /workspaces/:id/sprints (backward compat — returns all sprints in workspace)
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

  // POST /workspaces/:id/sprints (backward compat — assigns to first space)
  fastify.post("/workspaces/:id/sprints", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership || !["owner", "admin"].includes(membership.role)) return reply.status(403).send({ error: "Access denied" });

      const firstSpace = await db.query.spaces.findFirst({
        where: eq(spaces.workspaceId, workspaceId),
        orderBy: [asc(spaces.order)],
      });
      if (!firstSpace) return reply.status(400).send({ error: "No spaces in workspace" });

      const body = request.body as Record<string, unknown>;
      const validatedData = createSprintSchema.parse(body);
      const [sprint] = await db.insert(sprints).values({
        workspaceId, spaceId: firstSpace.id, name: validatedData.name,
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

  // GET /spaces/:spaceId/sprints
  fastify.get("/spaces/:spaceId/sprints", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { spaceId } = request.params as { spaceId: string };
    try {
      const space = await db.query.spaces.findFirst({ where: eq(spaces.id, spaceId) });
      if (!space) return reply.status(404).send({ error: "Space not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, space.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });
      const spaceSprints = await db.query.sprints.findMany({
        where: eq(sprints.spaceId, spaceId), orderBy: [asc(sprints.startDate)],
      });
      return { sprints: spaceSprints };
    } catch (error) {
      console.error("Error fetching space sprints:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /spaces/:spaceId/sprints
  fastify.post("/spaces/:spaceId/sprints", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { spaceId } = request.params as { spaceId: string };
    try {
      const space = await db.query.spaces.findFirst({ where: eq(spaces.id, spaceId) });
      if (!space) return reply.status(404).send({ error: "Space not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, space.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership || !["owner", "admin"].includes(membership.role)) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const validatedData = createSprintSchema.parse(body);
      const [sprint] = await db.insert(sprints).values({
        workspaceId: space.workspaceId, spaceId, name: validatedData.name,
        startDate: new Date(validatedData.startDate), endDate: new Date(validatedData.endDate),
        goal: validatedData.goal || null,
      }).returning();
      return reply.status(201).send({ sprint });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating space sprint:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
