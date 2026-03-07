import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { goals, keyResults, workspaceMembers } = schema;

const createGoalSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  targetDate: z.string().datetime().optional(),
  workspaceId: z.string().uuid(),
});

const updateGoalSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  targetDate: z.string().datetime().nullable().optional(),
  status: z.enum(["active", "completed", "archived"]).optional(),
});

const createKeyResultSchema = z.object({
  title: z.string().min(1).max(255),
  targetValue: z.number().int().positive(),
  linkedTaskId: z.string().uuid().optional(),
});

const updateKeyResultSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  targetValue: z.number().int().positive().optional(),
  currentValue: z.number().int().min(0).optional(),
  linkedTaskId: z.string().uuid().nullable().optional(),
});

export default async function goalRoutes(fastify: FastifyInstance) {
  // GET /goals
  fastify.get("/goals", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { workspaceId } = request.query as { workspaceId?: string };
    if (!workspaceId) return reply.status(400).send({ error: "workspaceId is required" });
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const goalsList = await db.query.goals.findMany({
        where: eq(goals.workspaceId, workspaceId),
        with: { keyResults: true },
        orderBy: (goals, { desc }) => [desc(goals.createdAt)],
        limit: 200,
      });

      const goalsWithProgress = goalsList.map(goal => {
        const totalTarget = goal.keyResults.reduce((sum, kr) => sum + kr.targetValue, 0);
        const totalCurrent = goal.keyResults.reduce((sum, kr) => sum + (kr.currentValue ?? 0), 0);
        const progress = totalTarget > 0 ? Math.round((totalCurrent / totalTarget) * 100) : 0;
        return {
          ...goal, progress,
          targetDate: goal.targetDate ? new Date(goal.targetDate).toISOString() : null,
          createdAt: goal.createdAt ? new Date(goal.createdAt).toISOString() : goal.createdAt,
        };
      });
      return { goals: goalsWithProgress };
    } catch (error) {
      console.error("Error fetching goals:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /goals
  fastify.post("/goals", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    try {
      const body = request.body as Record<string, unknown>;
      const validatedData = createGoalSchema.parse(body);
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, validatedData.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership || !["owner", "admin"].includes(membership.role)) return reply.status(403).send({ error: "Access denied" });

      const [goal] = await db.insert(goals).values({
        workspaceId: validatedData.workspaceId, name: validatedData.name,
        description: validatedData.description || null,
        targetDate: validatedData.targetDate ? new Date(validatedData.targetDate) : null, status: "active",
      }).returning();
      return reply.status(201).send({ goal });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating goal:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /goals/:id
  fastify.get("/goals/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: goalId } = request.params as { id: string };
    try {
      const goal = await db.query.goals.findFirst({ where: eq(goals.id, goalId), with: { keyResults: true } });
      if (!goal) return reply.status(404).send({ error: "Goal not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, goal.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const totalTarget = goal.keyResults.reduce((sum, kr) => sum + kr.targetValue, 0);
      const totalCurrent = goal.keyResults.reduce((sum, kr) => sum + (kr.currentValue ?? 0), 0);
      const progress = totalTarget > 0 ? Math.round((totalCurrent / totalTarget) * 100) : 0;
      return {
        goal: { ...goal, progress, targetDate: goal.targetDate ? new Date(goal.targetDate).toISOString() : null, createdAt: goal.createdAt ? new Date(goal.createdAt).toISOString() : goal.createdAt },
      };
    } catch (error) {
      console.error("Error fetching goal:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /goals/:id
  fastify.patch("/goals/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: goalId } = request.params as { id: string };
    try {
      const goal = await db.query.goals.findFirst({ where: eq(goals.id, goalId) });
      if (!goal) return reply.status(404).send({ error: "Goal not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, goal.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership || !["owner", "admin"].includes(membership.role)) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const validatedData = updateGoalSchema.parse(body);
      const updateData: Record<string, unknown> = {};
      if (validatedData.name !== undefined) updateData.name = validatedData.name;
      if (validatedData.description !== undefined) updateData.description = validatedData.description;
      if (validatedData.targetDate !== undefined) updateData.targetDate = validatedData.targetDate ? new Date(validatedData.targetDate) : null;
      if (validatedData.status !== undefined) updateData.status = validatedData.status;

      const [updatedGoal] = await db.update(goals).set(updateData).where(eq(goals.id, goalId)).returning();
      return {
        goal: { ...updatedGoal, targetDate: updatedGoal.targetDate ? new Date(updatedGoal.targetDate).toISOString() : null, createdAt: updatedGoal.createdAt ? new Date(updatedGoal.createdAt).toISOString() : updatedGoal.createdAt },
      };
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error updating goal:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /goals/:id
  fastify.delete("/goals/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: goalId } = request.params as { id: string };
    try {
      const goal = await db.query.goals.findFirst({ where: eq(goals.id, goalId) });
      if (!goal) return reply.status(404).send({ error: "Goal not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, goal.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership || !["owner", "admin"].includes(membership.role)) return reply.status(403).send({ error: "Access denied" });

      await db.transaction(async (tx) => {
        await tx.delete(keyResults).where(eq(keyResults.goalId, goalId));
        await tx.delete(goals).where(eq(goals.id, goalId));
      });
      return { success: true };
    } catch (error) {
      console.error("Error deleting goal:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /goals/:id/key-results
  fastify.get("/goals/:id/key-results", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: goalId } = request.params as { id: string };
    try {
      const goal = await db.query.goals.findFirst({ where: eq(goals.id, goalId) });
      if (!goal) return reply.status(404).send({ error: "Goal not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, goal.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const keyResultsList = await db.query.keyResults.findMany({ where: eq(keyResults.goalId, goalId) });
      return { keyResults: keyResultsList };
    } catch (error) {
      console.error("Error fetching key results:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /goals/:id/key-results
  fastify.post("/goals/:id/key-results", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: goalId } = request.params as { id: string };
    try {
      const goal = await db.query.goals.findFirst({ where: eq(goals.id, goalId) });
      if (!goal) return reply.status(404).send({ error: "Goal not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, goal.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership || !["owner", "admin"].includes(membership.role)) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const validatedData = createKeyResultSchema.parse(body);
      const [keyResult] = await db.insert(keyResults).values({
        goalId, title: validatedData.title, targetValue: validatedData.targetValue,
        currentValue: 0, linkedTaskId: validatedData.linkedTaskId || null,
      }).returning();
      return reply.status(201).send({ keyResult });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating key result:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /goals/:id/key-results/:krId
  fastify.patch("/goals/:id/key-results/:krId", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: goalId, krId } = request.params as { id: string; krId: string };
    try {
      const goal = await db.query.goals.findFirst({ where: eq(goals.id, goalId) });
      if (!goal) return reply.status(404).send({ error: "Goal not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, goal.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const kr = await db.query.keyResults.findFirst({
        where: and(eq(keyResults.id, krId), eq(keyResults.goalId, goalId)),
      });
      if (!kr) return reply.status(404).send({ error: "Key result not found" });

      const body = request.body as Record<string, unknown>;
      const validatedData = updateKeyResultSchema.parse(body);
      const updateData: Record<string, unknown> = {};
      if (validatedData.title !== undefined) updateData.title = validatedData.title;
      if (validatedData.targetValue !== undefined) updateData.targetValue = validatedData.targetValue;
      if (validatedData.currentValue !== undefined) updateData.currentValue = validatedData.currentValue;
      if (validatedData.linkedTaskId !== undefined) updateData.linkedTaskId = validatedData.linkedTaskId;

      const [updated] = await db.update(keyResults).set(updateData).where(eq(keyResults.id, krId)).returning();
      return { keyResult: updated };
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error updating key result:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /goals/:id/key-results/:krId
  fastify.delete("/goals/:id/key-results/:krId", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: goalId, krId } = request.params as { id: string; krId: string };
    try {
      const goal = await db.query.goals.findFirst({ where: eq(goals.id, goalId) });
      if (!goal) return reply.status(404).send({ error: "Goal not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, goal.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership || !["owner", "admin"].includes(membership.role)) return reply.status(403).send({ error: "Access denied" });

      const kr = await db.query.keyResults.findFirst({
        where: and(eq(keyResults.id, krId), eq(keyResults.goalId, goalId)),
      });
      if (!kr) return reply.status(404).send({ error: "Key result not found" });

      await db.delete(keyResults).where(eq(keyResults.id, krId));
      return { success: true };
    } catch (error) {
      console.error("Error deleting key result:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
