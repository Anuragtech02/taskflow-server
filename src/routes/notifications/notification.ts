import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { notifications, tasks, lists, spaces, workspaceMembers } = schema;

const createNotificationSchema = z.object({
  userId: z.string().uuid(),
  type: z.string().min(1).max(50),
  title: z.string().min(1).max(255),
  message: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().uuid().optional(),
});

export default async function notificationRoutes(fastify: FastifyInstance) {
  // GET /notifications
  fastify.get("/notifications", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    try {
      const { limit: l, offset: o, unread } = request.query as { limit?: string; offset?: string; unread?: string };
      const limit = Math.min(Math.max(parseInt(l || "50", 10) || 50, 1), 200);
      const offset = Math.max(parseInt(o || "0", 10) || 0, 0);
      const unreadOnly = unread === "true";

      const baseWhere = unreadOnly
        ? and(eq(notifications.userId, authResult.userId), eq(notifications.read, false))!
        : eq(notifications.userId, authResult.userId);

      const userNotifications = await db.select().from(notifications).where(baseWhere)
        .orderBy(desc(notifications.createdAt)).limit(limit).offset(offset);

      const enrichedNotifications = await Promise.all(
        userNotifications.map(async (notification) => {
          const enriched = { ...notification } as Record<string, unknown>;
          if (notification.entityType === "task" && notification.entityId) {
            try {
              const taskWithContext = await db.select({ id: tasks.id, listId: lists.id, spaceId: spaces.id, workspaceId: spaces.workspaceId })
                .from(tasks).innerJoin(lists, eq(tasks.listId, lists.id)).innerJoin(spaces, eq(lists.spaceId, spaces.id))
                .where(eq(tasks.id, notification.entityId)).limit(1);
              if (taskWithContext.length > 0) {
                enriched.workspaceId = taskWithContext[0].workspaceId;
                enriched.spaceId = taskWithContext[0].spaceId;
                enriched.listId = taskWithContext[0].listId;
              }
            } catch (err) { console.error("Error enriching notification:", err); }
          }
          return enriched;
        })
      );

      const unreadCount = await db.select({ count: sql<number>`count(*)` }).from(notifications)
        .where(and(eq(notifications.userId, authResult.userId), eq(notifications.read, false)));

      return { notifications: enrichedNotifications, unreadCount: unreadCount[0]?.count || 0 };
    } catch (error) {
      console.error("Error fetching notifications:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /notifications
  fastify.post("/notifications", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    try {
      const body = request.body as Record<string, unknown>;
      const validatedData = createNotificationSchema.parse(body);

      const senderWorkspaces = await db.select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers).where(eq(workspaceMembers.userId, authResult.userId));
      const senderWorkspaceIds = senderWorkspaces.map(w => w.workspaceId);

      if (senderWorkspaceIds.length === 0) return reply.status(403).send({ error: "Access denied" });

      const targetMembership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.userId, validatedData.userId), sql`${workspaceMembers.workspaceId} IN ${senderWorkspaceIds}`),
      });
      if (!targetMembership) return reply.status(403).send({ error: "Cannot create notifications for users outside your workspaces" });

      const [notification] = await db.insert(notifications).values({
        userId: validatedData.userId, type: validatedData.type, title: validatedData.title,
        message: validatedData.message || null, entityType: validatedData.entityType || null, entityId: validatedData.entityId || null,
      }).returning();
      return reply.status(201).send({ notification });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating notification:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /notifications
  fastify.patch("/notifications", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    try {
      const body = request.body as { notificationId?: string; markAllRead?: boolean };
      if (body.markAllRead) {
        await db.update(notifications).set({ read: true })
          .where(and(eq(notifications.userId, authResult.userId), eq(notifications.read, false)));
        return { success: true };
      }
      if (body.notificationId) {
        const [updated] = await db.update(notifications).set({ read: true })
          .where(and(eq(notifications.id, body.notificationId), eq(notifications.userId, authResult.userId))).returning();
        if (!updated) return reply.status(404).send({ error: "Notification not found" });
        return { notification: updated };
      }
      return reply.status(400).send({ error: "Provide notificationId or markAllRead: true" });
    } catch (error) {
      console.error("Error updating notification:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /notifications/:id/read
  fastify.patch("/notifications/:id/read", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: notificationId } = request.params as { id: string };
    try {
      const notification = await db.query.notifications.findFirst({
        where: and(eq(notifications.id, notificationId), eq(notifications.userId, authResult.userId)),
      });
      if (!notification) return reply.status(404).send({ error: "Notification not found" });
      const body = (request.body as { read?: boolean }) || {};
      const read = body.read ?? true;
      const [updated] = await db.update(notifications).set({ read }).where(eq(notifications.id, notificationId)).returning();
      return { notification: updated };
    } catch (error) {
      console.error("Error updating notification:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
