import { config } from "../../config.js";

/** True when every Discord credential is present; the feature is inert otherwise. */
export function isDiscordConfigured(): boolean {
  const d = config.discord;
  return Boolean(d.applicationId && d.publicKey && d.botToken && d.clientSecret);
}

export class DiscordApiError extends Error {
  constructor(public status: number, public body: unknown, path: string) {
    super(`Discord API ${status} on ${path}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
}

type Init = { method?: string; body?: unknown; auth?: "bot" | { bearer: string } | "none"; form?: Record<string, string> };

async function discordFetch<T>(path: string, init: Init = {}, attempt = 0): Promise<T> {
  const headers: Record<string, string> = { "User-Agent": "TaskFlowBot (https://taskflow.anuragtech.com, 1.0)" };
  const auth = init.auth ?? "bot";
  if (auth === "bot") headers.Authorization = `Bot ${config.discord.botToken}`;
  else if (auth !== "none") headers.Authorization = `Bearer ${auth.bearer}`;

  let body: string | undefined;
  if (init.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  } else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  const res = await fetch(`${config.discord.apiBase}${path}`, { method: init.method ?? "GET", headers, body });

  // Honour one rate-limit retry; beyond that surface the error rather than
  // stalling the scheduler tick.
  if (res.status === 429 && attempt === 0) {
    const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
    await new Promise((r) => setTimeout(r, Math.min(5, data.retry_after ?? 1) * 1000));
    return discordFetch<T>(path, init, 1);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const parsed = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
  if (!res.ok) throw new DiscordApiError(res.status, parsed, path);
  return parsed as T;
}

export interface DiscordChannel { id: string; name: string; type: number; position: number; parent_id: string | null }
export interface DiscordRole { id: string; name: string; color: number; position: number; managed: boolean }
export interface DiscordUser { id: string; username: string; global_name: string | null }
export interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  guild?: { id: string; name: string };
}

// Text + announcement channels are the ones a bot can post to.
const POSTABLE_CHANNEL_TYPES = new Set([0, 5]);

export const discordApi = {
  sendMessage: (channelId: string, message: unknown) =>
    discordFetch<{ id: string }>(`/channels/${channelId}/messages`, { method: "POST", body: message }),

  async listPostableChannels(guildId: string): Promise<DiscordChannel[]> {
    const all = await discordFetch<DiscordChannel[]>(`/guilds/${guildId}/channels`);
    return all.filter((c) => POSTABLE_CHANNEL_TYPES.has(c.type)).sort((a, b) => a.position - b.position);
  },

  async listMentionableRoles(guildId: string): Promise<DiscordRole[]> {
    const roles = await discordFetch<DiscordRole[]>(`/guilds/${guildId}/roles`);
    // Skip @everyone (id === guild id) and bot-managed integration roles.
    return roles.filter((r) => r.id !== guildId && !r.managed).sort((a, b) => b.position - a.position);
  },

  leaveGuild: (guildId: string) => discordFetch<void>(`/users/@me/guilds/${guildId}`, { method: "DELETE" }),

  exchangeCode: (code: string, redirectUri: string) =>
    discordFetch<DiscordTokenResponse>(`/oauth2/token`, {
      method: "POST",
      auth: "none",
      form: {
        client_id: config.discord.applicationId,
        client_secret: config.discord.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      },
    }),

  getCurrentUser: (accessToken: string) => discordFetch<DiscordUser>(`/users/@me`, { auth: { bearer: accessToken } }),

  /** Bulk-overwrite global commands. Idempotent: unchanged commands are updates, not creates. */
  registerCommands: (commands: unknown[]) =>
    discordFetch<unknown[]>(`/applications/${config.discord.applicationId}/commands`, { method: "PUT", body: commands }),
};
