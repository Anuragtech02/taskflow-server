import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { labels, workspaceMembers } = schema;

const createLabelSchema = z.object({
  name: z.string().min(1).max(255),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#6366f1"),
});

const updateLabelSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

export default async function labelRoutes(fastify: FastifyInstance) {
  // GET /workspaces/:id/labels
  fastify.get("/workspaces/:id/labels", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const workspaceLabels = await db.query.labels.findMany({ where: eq(labels.workspaceId, workspaceId) });
      return { labels: workspaceLabels };
    } catch (error) {
      console.error("Error fetching labels:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /workspaces/:id/labels
  fastify.post("/workspaces/:id/labels", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const result = createLabelSchema.safeParse(body);
      if (!result.success) return reply.status(400).send({ error: result.error.issues[0].message });

      const [newLabel] = await db.insert(labels).values({ workspaceId, name: result.data.name, color: result.data.color }).returning();
      return reply.status(201).send({ label: newLabel });
    } catch (error) {
      console.error("Error creating label:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /workspaces/:id/labels/:labelId
  fastify.patch("/workspaces/:id/labels/:labelId", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId, labelId } = request.params as { id: string; labelId: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const existingLabel = await db.query.labels.findFirst({
        where: and(eq(labels.id, labelId), eq(labels.workspaceId, workspaceId)),
      });
      if (!existingLabel) return reply.status(404).send({ error: "Label not found" });

      const body = request.body as Record<string, unknown>;
      const result = updateLabelSchema.safeParse(body);
      if (!result.success) return reply.status(400).send({ error: result.error.issues[0].message });

      const [updatedLabel] = await db.update(labels).set({
        ...(result.data.name && { name: result.data.name }),
        ...(result.data.color && { color: result.data.color }),
      }).where(eq(labels.id, labelId)).returning();

      return { label: updatedLabel };
    } catch (error) {
      console.error("Error updating label:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /workspaces/:id/labels/:labelId
  fastify.delete("/workspaces/:id/labels/:labelId", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId, labelId } = request.params as { id: string; labelId: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const existingLabel = await db.query.labels.findFirst({
        where: and(eq(labels.id, labelId), eq(labels.workspaceId, workspaceId)),
      });
      if (!existingLabel) return reply.status(404).send({ error: "Label not found" });

      await db.delete(labels).where(eq(labels.id, labelId));
      return { success: true };
    } catch (error) {
      console.error("Error deleting label:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
