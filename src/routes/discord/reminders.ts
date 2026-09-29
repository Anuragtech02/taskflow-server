import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { authenticateRequest } from "../../plugins/auth.js";
import { discordApi, isDiscordConfigured } from "../../lib/discord/api.js";
import { deliverReminder } from "../../lib/discord/deliver.js";
import { describeSchedule, nextOccurrence, scheduleSchema, type Schedule } from "../../lib/discord/schedule.js";
import { membership, MANAGE_REMINDER_ROLES } from "../../lib/discord/access.js";
import type { DiscordReminder } from "../../db/schema/index.js";

const { discordReminders, workspaceDiscordGuilds, workspaceMembers, tasks } = schema;
const snowflake = z.string().regex(/^\d{5,25}$/, "Invalid Discord id");

const reminderInput = z.object({
  name: z.string().trim().min(1, "Give the reminder a name").max(120),
  channelId: snowflake,
  message: z.string().trim().min(1, "Write a message").max(1800),
  taskId: z.string().uuid().nullable().optional(),
  mentionUserIds: z.array(z.string().uuid()).max(50).default([]),
  mentionRoleIds: z.array(snowflake).max(25).default([]),
  mentionHere: z.boolean().default(false),
  schedule: scheduleSchema,
  enabled: z.boolean().default(true),
});

function serialize(r: DiscordReminder) {
  return { ...r, scheduleSummary: scheduleSchema.safeParse(r.schedule).success ? describeSchedule(r.schedule as Schedule) : "Invalid schedule" };
}

type Guard = { userId: string; role: string; guildId: string } | null;

/** Auth + membership (+ optional write role) + connected server, or reply with the failure. */
async function guard(request: FastifyRequest, reply: FastifyReply, write: boolean): Promise<Guard> {
  const auth = await authenticateRequest(request);
  if (!auth) {
    reply.status(401).send({ error: "Unauthorized" });
    return null;
  }
  const { id } = request.params as { id: string };
  const m = await membership(id, auth.userId);
  if (!m) {
    reply.status(403).send({ error: "Forbidden" });
    return null;
  }
  if (write && !MANAGE_REMINDER_ROLES.includes(m.role)) {
    reply.status(403).send({ error: "Viewers can't change reminders" });
    return null;
  }
  const guild = await db.query.workspaceDiscordGuilds.findFirst({ where: eq(workspaceDiscordGuilds.workspaceId, id) });
  if (!guild) {
    reply.status(409).send({ error: "Connect a Discord server first" });
    return null;
  }
  return { userId: auth.userId, role: m.role, guildId: guild.guildId };
}

/** Cross-check references against the workspace and the connected server. Returns an error message or null. */
async function validateReferences(workspaceId: string, guildId: string, input: z.infer<typeof reminderInput>): Promise<string | null> {
  if (input.mentionUserIds.length) {
    const found = await db.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, input.mentionUserIds)));
    if (found.length !== new Set(input.mentionUserIds).size) return "Some tagged people aren't members of this workspace";
  }
  if (input.taskId) {
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, input.taskId), with: { list: { with: { space: true } } } });
    if (!task || task.list?.space?.workspaceId !== workspaceId) return "That task isn't in this workspace";
  }
  if (isDiscordConfigured()) {
    try {
      const channels = await discordApi.listPostableChannels(guildId);
      if (!channels.some((c) => c.id === input.channelId)) return "That channel isn't a text channel in the connected server";
      if (input.mentionRoleIds.length) {
        const roles = await discordApi.listMentionableRoles(guildId);
        if (!input.mentionRoleIds.every((id) => roles.some((r) => r.id === id))) return "Some roles aren't in the connected server";
      }
    } catch {
      return "Couldn't reach Discord to check the channel — try again";
    }
  }
  return null;
}

function firstIssue(err: z.ZodError): string {
  const i = err.issues[0];
  return i ? `${i.path.join(".") || "body"}: ${i.message}` : "Invalid body";
}

export default async function discordReminderRoutes(fastify: FastifyInstance) {
  fastify.get("/workspaces/:id/discord/reminders", async (request, reply) => {
    const g = await guard(request, reply, false);
    if (!g) return reply;
    const { id } = request.params as { id: string };
    const rows = await db.select().from(discordReminders).where(eq(discordReminders.workspaceId, id)).orderBy(desc(discordReminders.createdAt));
    return { reminders: rows.map(serialize) };
  });

  fastify.post("/workspaces/:id/discord/reminders", async (request, reply) => {
    const g = await guard(request, reply, true);
    if (!g) return reply;
    const { id } = request.params as { id: string };
    const parsed = reminderInput.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: firstIssue(parsed.error) });
    const input = parsed.data;
    const refError = await validateReferences(id, g.guildId, input);
    if (refError) return reply.status(400).send({ error: refError });

    const nextRunAt = nextOccurrence(input.schedule, new Date());
    if (!nextRunAt) return reply.status(400).send({ error: "That time has already passed" });

    const [row] = await db.insert(discordReminders).values({
      workspaceId: id, createdBy: g.userId, ...input, taskId: input.taskId ?? null,
      // Kept even when created paused, so the dashboard can show when it would run.
      nextRunAt,
    }).returning();
    return reply.status(201).send({ reminder: serialize(row) });
  });

  fastify.patch("/workspaces/:id/discord/reminders/:rid", async (request, reply) => {
    const g = await guard(request, reply, true);
    if (!g) return reply;
    const { id, rid } = request.params as { id: string; rid: string };
    const existing = await db.query.discordReminders.findFirst({ where: and(eq(discordReminders.id, rid), eq(discordReminders.workspaceId, id)) });
    if (!existing) return reply.status(404).send({ error: "Reminder not found" });

    // PATCH merges onto the stored reminder, then validates the whole thing.
    const merged = { ...existing, taskId: existing.taskId, ...(request.body as object) };
    const parsed = reminderInput.safeParse(merged);
    if (!parsed.success) return reply.status(400).send({ error: firstIssue(parsed.error) });
    const input = parsed.data;
    const refError = await validateReferences(id, g.guildId, input);
    if (refError) return reply.status(400).send({ error: refError });

    // Any schedule/enable change re-anchors the next run on "now".
    const nextRunAt = nextOccurrence(input.schedule, new Date());
    if (!nextRunAt && input.enabled) return reply.status(400).send({ error: "That time has already passed" });

    const [row] = await db.update(discordReminders)
      .set({ ...input, taskId: input.taskId ?? null, nextRunAt, updatedAt: new Date(),
             ...(input.enabled && existing.lastStatus === "failed" && { lastError: null }) })
      .where(eq(discordReminders.id, rid))
      .returning();
    return { reminder: serialize(row) };
  });

  fastify.delete("/workspaces/:id/discord/reminders/:rid", async (request, reply) => {
    const g = await guard(request, reply, true);
    if (!g) return reply;
    const { id, rid } = request.params as { id: string; rid: string };
    const [row] = await db.delete(discordReminders).where(and(eq(discordReminders.id, rid), eq(discordReminders.workspaceId, id))).returning({ id: discordReminders.id });
    if (!row) return reply.status(404).send({ error: "Reminder not found" });
    return { success: true };
  });

  // Send right now as a test; doesn't touch the schedule.
  fastify.post("/workspaces/:id/discord/reminders/:rid/test", async (request, reply) => {
    const g = await guard(request, reply, true);
    if (!g) return reply;
    if (!isDiscordConfigured()) return reply.status(503).send({ error: "Discord integration is not configured" });
    const { id, rid } = request.params as { id: string; rid: string };
    const r = await db.query.discordReminders.findFirst({ where: and(eq(discordReminders.id, rid), eq(discordReminders.workspaceId, id)) });
    if (!r) return reply.status(404).send({ error: "Reminder not found" });
    try {
      const { unlinkedUserIds } = await deliverReminder(r, { test: true });
      return { success: true, unlinkedUserIds };
    } catch (error) {
      return reply.status(502).send({ error: `Discord rejected the message: ${error instanceof Error ? error.message : String(error)}` });
    }
  });
}
