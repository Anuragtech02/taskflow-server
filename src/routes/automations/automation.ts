import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { automations, workspaceMembers } = schema;

const updateAutomationSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  triggerType: z.enum(["status_change", "task_created", "due_date_approaching", "assignment"]).optional(),
  triggerConfig: z.record(z.string(), z.any()).optional(),
  actionType: z.enum(["change_status", "assign_user", "add_label", "send_notification"]).optional(),
  actionConfig: z.record(z.string(), z.any()).optional(),
  enabled: z.boolean().optional(),
});

export default async function automationRoutes(fastify: FastifyInstance) {
  // GET /automations/:id
  fastify.get("/automations/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const automation = await db.query.automations.findFirst({ where: eq(automations.id, id) });
      if (!automation) return reply.status(404).send({ error: "Automation not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, automation.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });
      return { automation };
    } catch (error) {
      console.error("Error fetching automation:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /automations/:id
  fastify.patch("/automations/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const automation = await db.query.automations.findFirst({ where: eq(automations.id, id) });
      if (!automation) return reply.status(404).send({ error: "Automation not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, automation.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership || !["owner", "admin"].includes(membership.role)) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const validatedData = updateAutomationSchema.parse(body);
      const [updated] = await db.update(automations).set({ ...validatedData, updatedAt: new Date() }).where(eq(automations.id, id)).returning();
      return { automation: updated };
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error updating automation:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /automations/:id
  fastify.delete("/automations/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const automation = await db.query.automations.findFirst({ where: eq(automations.id, id) });
      if (!automation) return reply.status(404).send({ error: "Automation not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, automation.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership || !["owner", "admin"].includes(membership.role)) return reply.status(403).send({ error: "Access denied" });

      await db.delete(automations).where(eq(automations.id, id));
      return { success: true };
    } catch (error) {
      console.error("Error deleting automation:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
