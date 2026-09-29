import { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { IANAZone } from "luxon";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { config } from "../../config.js";
import { authenticateRequest } from "../../plugins/auth.js";
import { discordApi, DiscordApiError, isDiscordConfigured } from "../../lib/discord/api.js";
import { createState, readState } from "../../lib/discord/state.js";
import { membership, MANAGE_CONNECTION_ROLES, MANAGE_REMINDER_ROLES } from "../../lib/discord/access.js";

const { userDiscordAccounts, workspaceDiscordGuilds, discordReminders, workspaceMembers, users } = schema;

// View Channel + Send Messages + Embed Links + Mention Everyone (for @here and roles).
const BOT_PERMISSIONS = String((1 << 10) | (1 << 11) | (1 << 14) | (1 << 17));
const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const redirectUri = () => `${config.publicApiUrl}/discord/oauth/callback`;
const settingsPage = (params: Record<string, string>) =>
  `${config.appUrl}/dashboard/settings?${new URLSearchParams({ tab: "integrations", ...params })}`;
const safeZone = (tz: unknown) => (typeof tz === "string" && IANAZone.isValidZone(tz) ? tz : "UTC");

function notConfigured(reply: FastifyReply) {
  return reply.status(503).send({ error: "Discord integration is not configured on this server" });
}

export default async function discordConnectRoutes(fastify: FastifyInstance) {
  // ── Account linking (per user) ─────────────────────────────────────────────

  fastify.get("/discord/status", async (request, reply) => {
    const auth = await authenticateRequest(request);
    if (!auth) return reply.status(401).send({ error: "Unauthorized" });
    const account = await db.query.userDiscordAccounts.findFirst({ where: eq(userDiscordAccounts.userId, auth.userId) });
    return {
      configured: isDiscordConfigured(),
      account: account ? { discordUsername: account.discordUsername, linkedAt: account.linkedAt } : null,
    };
  });

  // Browser navigates here (top-level), carrying the session cookie.
  fastify.get("/discord/link/start", async (request, reply) => {
    if (!isDiscordConfigured()) return reply.redirect(settingsPage({ discord_error: "not_configured" }));
    const auth = await authenticateRequest(request);
    if (!auth) return reply.redirect(`${config.appUrl}/login?redirect=${encodeURIComponent("/dashboard/settings?tab=integrations")}`);
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: config.discord.applicationId,
      response_type: "code",
      redirect_uri: redirectUri(),
      scope: "identify",
      prompt: "consent",
      state: createState({ kind: "link", userId: auth.userId }),
    }).toString();
    return reply.redirect(url.toString());
  });

  fastify.delete("/discord/link", async (request, reply) => {
    const auth = await authenticateRequest(request);
    if (!auth) return reply.status(401).send({ error: "Unauthorized" });
    await db.delete(userDiscordAccounts).where(eq(userDiscordAccounts.userId, auth.userId));
    return { success: true };
  });

  // ── Server connection (per workspace) ──────────────────────────────────────

  fastify.get("/workspaces/:id/discord", async (request, reply) => {
    const auth = await authenticateRequest(request);
    if (!auth) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    const m = await membership(id, auth.userId);
    if (!m) return reply.status(403).send({ error: "Forbidden" });
    const guild = await db.query.workspaceDiscordGuilds.findFirst({ where: eq(workspaceDiscordGuilds.workspaceId, id) });
    return {
      configured: isDiscordConfigured(),
      canManageConnection: MANAGE_CONNECTION_ROLES.includes(m.role),
      canManageReminders: MANAGE_REMINDER_ROLES.includes(m.role),
      guild: guild ? { id: guild.guildId, name: guild.guildName, timezone: guild.timezone, installedAt: guild.installedAt } : null,
    };
  });

  fastify.get("/workspaces/:id/discord/install/start", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { tz } = request.query as { tz?: string };
    if (!isDiscordConfigured()) return reply.redirect(settingsPage({ discord_error: "not_configured" }));
    const auth = await authenticateRequest(request);
    if (!auth) return reply.redirect(`${config.appUrl}/login`);
    const m = await membership(id, auth.userId);
    if (!m || !MANAGE_CONNECTION_ROLES.includes(m.role)) return reply.redirect(settingsPage({ discord_error: "forbidden" }));
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: config.discord.applicationId,
      response_type: "code",
      redirect_uri: redirectUri(),
      // identify: installing also links the installer's own Discord account.
      scope: "identify bot applications.commands",
      permissions: BOT_PERMISSIONS,
      integration_type: "0",
      state: createState({ kind: "install", userId: auth.userId, workspaceId: id, timezone: safeZone(tz) }),
    }).toString();
    return reply.redirect(url.toString());
  });

  fastify.patch("/workspaces/:id/discord", async (request, reply) => {
    const auth = await authenticateRequest(request);
    if (!auth) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    const m = await membership(id, auth.userId);
    if (!m || !MANAGE_CONNECTION_ROLES.includes(m.role)) return reply.status(403).send({ error: "Only workspace owners and admins can change this" });
    const parsed = z.object({ timezone: z.string().refine((t) => IANAZone.isValidZone(t), "Unknown timezone") }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    const [row] = await db.update(workspaceDiscordGuilds).set({ timezone: parsed.data.timezone }).where(eq(workspaceDiscordGuilds.workspaceId, id)).returning();
    if (!row) return reply.status(404).send({ error: "No Discord server connected" });
    return { success: true };
  });

  fastify.delete("/workspaces/:id/discord", async (request, reply) => {
    const auth = await authenticateRequest(request);
    if (!auth) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    const m = await membership(id, auth.userId);
    if (!m || !MANAGE_CONNECTION_ROLES.includes(m.role)) return reply.status(403).send({ error: "Only workspace owners and admins can disconnect Discord" });
    const [guild] = await db.delete(workspaceDiscordGuilds).where(eq(workspaceDiscordGuilds.workspaceId, id)).returning();
    if (!guild) return reply.status(404).send({ error: "No Discord server connected" });
    // Keep reminders (reconnecting restores them) but stop them firing.
    await db.update(discordReminders)
      .set({ enabled: false, lastStatus: "failed", lastError: "Discord server was disconnected — reconnect and re-enable" })
      .where(eq(discordReminders.workspaceId, id));
    // Best effort: remove the bot from the server too.
    if (isDiscordConfigured()) await discordApi.leaveGuild(guild.guildId).catch(() => undefined);
    return { success: true };
  });

  // ── OAuth callback (both flows) ────────────────────────────────────────────

  fastify.get("/discord/oauth/callback", async (request, reply) => {
    const q = request.query as { code?: string; state?: string; guild_id?: string; error?: string };
    const state = readState(q.state);
    if (!state) return reply.redirect(settingsPage({ discord_error: "expired" }));
    if (q.error || !q.code) return reply.redirect(settingsPage({ discord_error: "cancelled" }));
    if (!isDiscordConfigured()) return reply.redirect(settingsPage({ discord_error: "not_configured" }));

    // The browser finishing the flow must be the TaskFlow user who started it.
    const auth = await authenticateRequest(request);
    if (!auth || auth.userId !== state.userId) return reply.redirect(settingsPage({ discord_error: "session_mismatch" }));

    let token, me;
    try {
      token = await discordApi.exchangeCode(q.code, redirectUri());
      me = await discordApi.getCurrentUser(token.access_token);
    } catch (error) {
      request.log.error({ err: error instanceof DiscordApiError ? error.message : String(error) }, "discord oauth exchange failed");
      return reply.redirect(settingsPage({ discord_error: "oauth_failed" }));
    }

    // One Discord identity ↔ one TaskFlow user.
    const existing = await db.query.userDiscordAccounts.findFirst({ where: eq(userDiscordAccounts.discordUserId, me.id) });
    if (existing && existing.userId !== auth.userId) return reply.redirect(settingsPage({ discord_error: "discord_in_use" }));
    await db.insert(userDiscordAccounts)
      .values({ userId: auth.userId, discordUserId: me.id, discordUsername: me.global_name || me.username })
      .onConflictDoUpdate({
        target: userDiscordAccounts.userId,
        set: { discordUserId: me.id, discordUsername: me.global_name || me.username, linkedAt: new Date() },
      });

    if (state.kind === "link") return reply.redirect(settingsPage({ discord: "linked" }));

    // Install: re-check the role at completion time, not just at start.
    const m = await membership(state.workspaceId, auth.userId);
    if (!m || !MANAGE_CONNECTION_ROLES.includes(m.role)) return reply.redirect(settingsPage({ discord_error: "forbidden" }));
    const guildId = token.guild?.id ?? q.guild_id;
    if (!guildId) return reply.redirect(settingsPage({ discord_error: "no_server" }));

    const taken = await db.query.workspaceDiscordGuilds.findFirst({ where: eq(workspaceDiscordGuilds.guildId, guildId) });
    if (taken && taken.workspaceId !== state.workspaceId) return reply.redirect(settingsPage({ discord_error: "server_in_use" }));

    await db.insert(workspaceDiscordGuilds)
      .values({ workspaceId: state.workspaceId, guildId, guildName: token.guild?.name ?? null, installedBy: auth.userId, timezone: state.timezone })
      .onConflictDoUpdate({
        target: workspaceDiscordGuilds.workspaceId,
        set: { guildId, guildName: token.guild?.name ?? null, installedBy: auth.userId, installedAt: new Date(), timezone: state.timezone },
      });
    return reply.redirect(settingsPage({ discord: "installed", workspace: state.workspaceId }));
  });

  // ── Pickers for the reminder form ──────────────────────────────────────────

  async function connectedGuild(request: Parameters<typeof authenticateRequest>[0], reply: FastifyReply) {
    const auth = await authenticateRequest(request);
    if (!auth) {
      reply.status(401).send({ error: "Unauthorized" });
      return null;
    }
    const { id } = request.params as { id: string };
    if (!(await membership(id, auth.userId))) {
      reply.status(403).send({ error: "Forbidden" });
      return null;
    }
    if (!isDiscordConfigured()) {
      notConfigured(reply);
      return null;
    }
    const guild = await db.query.workspaceDiscordGuilds.findFirst({ where: eq(workspaceDiscordGuilds.workspaceId, id) });
    if (!guild) {
      reply.status(404).send({ error: "No Discord server connected" });
      return null;
    }
    return guild;
  }

  fastify.get("/workspaces/:id/discord/channels", async (request, reply) => {
    const guild = await connectedGuild(request, reply);
    if (!guild) return reply;
    try {
      const channels = await discordApi.listPostableChannels(guild.guildId);
      return { channels: channels.map((c) => ({ id: c.id, name: c.name })) };
    } catch (error) {
      request.log.error({ err: String(error) }, "discord channels fetch failed");
      return reply.status(502).send({ error: "Couldn't load channels from Discord. Is the bot still in the server?" });
    }
  });

  fastify.get("/workspaces/:id/discord/roles", async (request, reply) => {
    const guild = await connectedGuild(request, reply);
    if (!guild) return reply;
    try {
      const roles = await discordApi.listMentionableRoles(guild.guildId);
      return { roles: roles.map((r) => ({ id: r.id, name: r.name, color: r.color })) };
    } catch (error) {
      request.log.error({ err: String(error) }, "discord roles fetch failed");
      return reply.status(502).send({ error: "Couldn't load roles from Discord. Is the bot still in the server?" });
    }
  });

  // Workspace members + whether each has linked Discord (only linked ones can be pinged).
  fastify.get("/workspaces/:id/discord/members", async (request, reply) => {
    const auth = await authenticateRequest(request);
    if (!auth) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    if (!(await membership(id, auth.userId))) return reply.status(403).send({ error: "Forbidden" });
    const rows = await db
      .select({ userId: workspaceMembers.userId, name: users.name, email: users.email, avatarUrl: users.avatarUrl })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, id));
    const linked = rows.length
      ? await db.select().from(userDiscordAccounts).where(inArray(userDiscordAccounts.userId, rows.map((r) => r.userId)))
      : [];
    const byUser = new Map(linked.map((l) => [l.userId, l.discordUsername]));
    return { members: rows.map((r) => ({ ...r, discordLinked: byUser.has(r.userId), discordUsername: byUser.get(r.userId) ?? null })) };
  });

}
