import { describe, expect, it } from "vitest";
import { channelPermissions, describeAccess, friendlyDiscordError, PERMISSIONS as P } from "./permissions.js";

const GUILD = "1", BOT = "9", BOT_ROLE = "50", OTHER_ROLE = "60";
const s = (n: bigint) => String(n);
const PUBLIC = s(P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS | P.MENTION_EVERYONE);
const roles = [{ id: GUILD, permissions: PUBLIC }, { id: BOT_ROLE, permissions: "0" }, { id: OTHER_ROLE, permissions: "0" }];
const access = (overwrites: { id: string; type: number; allow?: bigint; deny?: bigint }[], r = roles) =>
  describeAccess(channelPermissions({
    guildId: GUILD, roles: r, memberId: BOT, memberRoleIds: [BOT_ROLE],
    overwrites: overwrites.map((o) => ({ id: o.id, type: o.type, allow: s(o.allow ?? 0n), deny: s(o.deny ?? 0n) })),
  }));

describe("bot channel access", () => {
  it("public channel: can post, nothing missing", () => {
    expect(access([])).toEqual({ canPost: true, missing: [] });
  });
  it("private channel the bot wasn't added to: can't post", () => {
    expect(access([{ id: GUILD, type: 0, deny: P.VIEW_CHANNEL }])).toEqual({ canPost: false, missing: ["View Channel"] });
  });
  it("private channel with the bot's role added: can post", () => {
    expect(access([{ id: GUILD, type: 0, deny: P.VIEW_CHANNEL }, { id: BOT_ROLE, type: 0, allow: P.VIEW_CHANNEL | P.SEND_MESSAGES }]).canPost).toBe(true);
  });
  it("private channel with the bot added as a member: can post", () => {
    expect(access([{ id: GUILD, type: 0, deny: P.VIEW_CHANNEL }, { id: BOT, type: 1, allow: P.VIEW_CHANNEL }]).canPost).toBe(true);
  });
  it("a role the bot doesn't have doesn't help", () => {
    expect(access([{ id: GUILD, type: 0, deny: P.VIEW_CHANNEL }, { id: OTHER_ROLE, type: 0, allow: P.VIEW_CHANNEL }]).canPost).toBe(false);
  });
  it("member overwrite beats role overwrite", () => {
    expect(access([{ id: BOT_ROLE, type: 0, allow: P.SEND_MESSAGES }, { id: BOT, type: 1, deny: P.SEND_MESSAGES }]))
      .toEqual({ canPost: false, missing: ["Send Messages"] });
  });
  it("read-only channel: can view but not send", () => {
    expect(access([{ id: GUILD, type: 0, deny: P.SEND_MESSAGES }])).toEqual({ canPost: false, missing: ["Send Messages"] });
  });
  it("administrator bypasses overwrites", () => {
    const admin = [{ id: GUILD, permissions: "0" }, { id: BOT_ROLE, permissions: s(P.ADMINISTRATOR) }];
    expect(access([{ id: GUILD, type: 0, deny: P.VIEW_CHANNEL }], admin)).toEqual({ canPost: true, missing: [] });
  });
  it("missing Embed Links / Mention Everyone is reported but doesn't block", () => {
    expect(access([{ id: GUILD, type: 0, deny: P.EMBED_LINKS | P.MENTION_EVERYONE }]))
      .toEqual({ canPost: true, missing: ["Embed Links", "Mention Everyone"] });
  });
});

describe("friendlyDiscordError", () => {
  it("explains Missing Access", () => {
    expect(friendlyDiscordError({ body: { code: 50001 } })).toMatch(/private/);
  });
  it("leaves unknown errors alone", () => {
    expect(friendlyDiscordError(new Error("boom"))).toBeNull();
  });
});
