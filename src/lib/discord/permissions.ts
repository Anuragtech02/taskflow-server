/**
 * The bot's effective permissions in a channel, computed the way Discord does
 * (https://discord.com/developers/docs/topics/permissions#permission-overwrites):
 * server roles first, then the channel's overwrites for @everyone, for the
 * bot's roles, and for the bot itself. Private channels are just channels
 * whose @everyone overwrite denies View Channel — so unless the bot (or one
 * of its roles) was added to the channel, it can't see or post in it, and
 * Discord answers 403 "Missing Access".
 */

export const PERMISSIONS = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  MENTION_EVERYONE: 1n << 17n,
} as const;

const ALL = (1n << 64n) - 1n;

export interface Overwrite { id: string; type: number | string; allow: string; deny: string }
export interface RoleLike { id: string; permissions?: string }

export function channelPermissions(opts: {
  guildId: string;
  roles: RoleLike[];
  memberId: string;
  memberRoleIds: string[];
  overwrites: Overwrite[];
}): bigint {
  const perms = (r?: RoleLike) => BigInt(r?.permissions ?? "0");
  const everyone = opts.roles.find((r) => r.id === opts.guildId);
  let base = perms(everyone);
  for (const id of opts.memberRoleIds) base |= perms(opts.roles.find((r) => r.id === id));
  if (base & PERMISSIONS.ADMINISTRATOR) return ALL;

  const apply = (o?: Pick<Overwrite, "allow" | "deny">) => {
    if (!o) return;
    base &= ~BigInt(o.deny);
    base |= BigInt(o.allow);
  };
  apply(opts.overwrites.find((o) => o.id === opts.guildId));
  // All role overwrites combine before applying (denies, then allows).
  let roleAllow = 0n, roleDeny = 0n;
  for (const o of opts.overwrites) {
    if (o.id !== opts.guildId && opts.memberRoleIds.includes(o.id)) {
      roleAllow |= BigInt(o.allow);
      roleDeny |= BigInt(o.deny);
    }
  }
  apply({ allow: String(roleAllow), deny: String(roleDeny) });
  apply(opts.overwrites.find((o) => o.id === opts.memberId && String(o.type) === "1"));
  return base;
}

export interface ChannelAccess {
  /** The bot can see the channel and post in it. */
  canPost: boolean;
  /** Human names of what's missing; blocking ones make canPost false. */
  missing: string[];
}

export function describeAccess(p: bigint): ChannelAccess {
  const has = (bit: bigint) => (p & bit) === bit;
  const missing: string[] = [];
  if (!has(PERMISSIONS.VIEW_CHANNEL)) missing.push("View Channel");
  if (!has(PERMISSIONS.SEND_MESSAGES)) missing.push("Send Messages");
  const canPost = missing.length === 0;
  // Non-blocking: the message still posts, just without the task card / ping.
  if (!has(PERMISSIONS.EMBED_LINKS)) missing.push("Embed Links");
  if (!has(PERMISSIONS.MENTION_EVERYONE)) missing.push("Mention Everyone");
  return { canPost, missing };
}

/** Plain-language explanation for the Discord errors a reminder can hit. */
export function friendlyDiscordError(err: unknown): string | null {
  const body = (err as { body?: { code?: number } } | null)?.body;
  switch (body?.code) {
    case 50001:
      return "The TaskFlow bot can't see this channel (it's private). In Discord, open the channel's settings → Permissions → Add members or roles → add TaskFlow, and allow View Channel and Send Messages.";
    case 50013:
      return "The TaskFlow bot doesn't have permission to post here. In Discord, open the channel's settings → Permissions and allow Send Messages (and Embed Links) for TaskFlow.";
    case 10003:
      return "This channel no longer exists in Discord. Edit the reminder and pick another channel.";
    case 10004:
      return "The TaskFlow bot is no longer in the Discord server. Reconnect the server in Settings → Integrations.";
    default:
      return null;
  }
}
