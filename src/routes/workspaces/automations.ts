import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { automations, workspaceMembers } = schema;

const createAutomationSchema = z.object({
  name: z.string().min(1).max(255),
  triggerType: z.enum(["status_change", "task_created", "due_date_approaching", "assignment"]),
  triggerConfig: z.record(z.string(), z.any()).default({}),
  actionType: z.enum(["change_status", "assign_user", "add_label", "send_notification"]),
  actionConfig: z.record(z.string(), z.any()).default({}),
  enabled: z.boolean().default(true),
});

export default async function workspaceAutomationRoutes(fastify: FastifyInstance) {
  // GET /workspaces/:id/automations
  fastify.get("/workspaces/:id/automations", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });
      const workspaceAutomations = await db.query.automations.findMany({ where: eq(automations.workspaceId, workspaceId), limit: 200 });
      return { automations: workspaceAutomations };
    } catch (error) {
      console.error("Error fetching automations:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /workspaces/:id/automations
  fastify.post("/workspaces/:id/automations", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership || !["owner", "admin"].includes(membership.role)) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const validatedData = createAutomationSchema.parse(body);
      const [automation] = await db.insert(automations).values({ ...validatedData, workspaceId }).returning();
      return reply.status(201).send({ automation });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating automation:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
