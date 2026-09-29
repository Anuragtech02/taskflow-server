/**
 * End-to-end tests for the Discord integration against a real Postgres and
 * the real compiled server (dist/index.js), with Discord's API mocked locally.
 *
 *   docker run -d --name tf-test-pg -e POSTGRES_USER=taskflow -e POSTGRES_PASSWORD=taskflow \
 *     -e POSTGRES_DB=taskflow -p 55432:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://taskflow:taskflow@localhost:55432/taskflow npx drizzle-kit push --force
 *   E2E_DATABASE_URL=postgresql://taskflow:taskflow@localhost:55432/taskflow npm run test:e2e
 *
 * Two server instances run against the same database throughout, so every
 * scheduler assertion also proves no double-sends during a rolling deploy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";
import { EncryptJWT } from "jose";
import { hkdf } from "@panva/hkdf";

const DB_URL = process.env.E2E_DATABASE_URL;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT_A = 19301, PORT_B = 19302, MOCK_PORT = 19399;
const SECRET = "e2e-nextauth-secret";
const APP_URL = "https://app.test";
const API_A = `http://127.0.0.1:${PORT_A}`;
const APP_ID = "111111111111111111";
const GUILD = "222222222222222222", NEW_GUILD = "222222222222222299";
const CHANNEL = "333333333333333333", VOICE = "333333333333333399";
const ROLE = "444444444444444444", MANAGED_ROLE = "444444444444444499";
const DISCORD_A = "555555555555555555", DISCORD_B = "555555555555555566", STRANGER = "555555555555555577";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB_HEX = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");

// ── Mock Discord API ─────────────────────────────────────────────────────────
type Call = { method: string; path: string; body: any };
const calls: Call[] = [];
let mockMe = { id: DISCORD_A, username: "alice", global_name: "Alice" };
let mockTokenGuild: { id: string; name: string } | undefined;
let mock: Server;

const readBody = (req: IncomingMessage) =>
  new Promise<string>((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });

function startMock() {
  mock = createServer(async (req, res) => {
    const raw = await readBody(req);
    const path = (req.url ?? "").replace("/api/v10", "");
    let body: any = raw;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    calls.push({ method: req.method!, path, body });
    const json = (code: number, data: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== "Bot bot-token" && !path.startsWith("/oauth2") && !path.startsWith("/users/@me"))
      return json(401, { message: "bad bot token" });
    if (req.method === "GET" && path.endsWith("/channels"))
      return json(200, [
        { id: VOICE, name: "voice", type: 2, position: 1, parent_id: null },
        { id: CHANNEL, name: "general", type: 0, position: 0, parent_id: null },
      ]);
    if (req.method === "GET" && path.endsWith("/roles"))
      return json(200, [
        { id: GUILD, name: "@everyone", color: 0, position: 0, managed: false },
        { id: ROLE, name: "devs", color: 1, position: 2, managed: false },
        { id: MANAGED_ROLE, name: "TaskFlow", color: 0, position: 3, managed: true },
      ]);
    if (req.method === "POST" && path.startsWith("/channels/")) return json(200, { id: `msg-${calls.length}` });
    if (req.method === "PUT" && path.includes("/commands")) return json(200, body);
    if (req.method === "POST" && path === "/oauth2/token")
      return json(200, { access_token: "user-token", token_type: "Bearer", scope: "identify", ...(mockTokenGuild && { guild: mockTokenGuild }) });
    if (req.method === "GET" && path === "/users/@me") return json(200, mockMe);
    if (req.method === "DELETE") { res.writeHead(204); return res.end(); }
    json(404, { message: "not mocked" });
  });
  return new Promise<void>((r) => mock.listen(MOCK_PORT, "127.0.0.1", () => r()));
}
const messagesTo = (channel: string) => calls.filter((c) => c.method === "POST" && c.path === `/channels/${channel}/messages`);

// ── Servers ──────────────────────────────────────────────────────────────────
const servers: ChildProcess[] = [];
const serverLogs: string[] = [];
function startServer(port: number) {
  const child = spawn("node", ["dist/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test", PORT: String(port), HOST: "127.0.0.1", DATABASE_URL: DB_URL,
      NEXTAUTH_SECRET: SECRET, NEXT_PUBLIC_APP_URL: APP_URL, CORS_ORIGIN: APP_URL,
      PUBLIC_API_URL: `http://127.0.0.1:${port}`,
      DISCORD_APPLICATION_ID: APP_ID, DISCORD_PUBLIC_KEY: PUB_HEX, DISCORD_BOT_TOKEN: "bot-token",
      DISCORD_CLIENT_SECRET: "client-secret", DISCORD_API_BASE: `http://127.0.0.1:${MOCK_PORT}/api/v10`,
      SCHEDULER_TICK_MS: "700",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => serverLogs.push(String(d)));
  child.stderr!.on("data", (d) => serverLogs.push(String(d)));
  servers.push(child);
  return (async () => {
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`server ${port} didn't start:\n${serverLogs.join("").slice(-3000)}`);
  })();
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function interact(body: object, opts: { tamper?: boolean; ts?: number; sig?: string | null } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(ts + raw), privateKey).toString("hex");
  const headers: Record<string, string> = { "content-type": "application/json", "x-signature-timestamp": ts };
  if (opts.sig !== null) headers["x-signature-ed25519"] = opts.sig ?? sig;
  const res = await fetch(`${API_A}/discord/interactions`, { method: "POST", headers, body: opts.tamper ? raw.replace("tasks", "task") : raw });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const command = (name: string, options: object[] = [], who = DISCORD_A, guild: string | undefined = GUILD) =>
  interact({ type: 2, guild_id: guild, member: { user: { id: who } }, data: { name, options } });

const KEY_A = "tfk_e2e_alice", KEY_V = "tfk_e2e_viewer";
const api = (path: string, init: { method?: string; body?: unknown; key?: string; cookie?: string } = {}) =>
  fetch(`${API_A}${path}`, {
    method: init.method ?? "GET",
    redirect: "manual",
    headers: {
      ...(init.key !== undefined ? { authorization: `Bearer ${init.key}` } : !init.cookie ? { authorization: `Bearer ${KEY_A}` } : {}),
      ...(init.cookie && { cookie: init.cookie }),
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

async function sessionCookie(userId: string) {
  const key = await hkdf("sha256", SECRET, "session-token", "Auth.js Generated Encryption Key (session-token)", 64);
  const jwe = await new EncryptJWT({ id: userId, sub: userId })
    .setProtectedHeader({ alg: "dir", enc: "A256CBC-HS512" }).setIssuedAt().setExpirationTime("1h").encrypt(key);
  return `session-token=${jwe}`;
}
const waitFor = async (cond: () => Promise<boolean> | boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 150)); }
  return false;
};

// ── Seed ─────────────────────────────────────────────────────────────────────
const U = { A: randomUUID(), B: randomUUID(), V: randomUUID(), X: randomUUID() };
const W = randomUUID(), W2 = randomUUID(), W3 = randomUUID();
const T = { overdue: randomUUID(), today: randomUUID(), nodue: randomUUID(), done: randomUUID(), archived: randomUUID(), bobs: randomUUID(), foreign: randomUUID() };
const TITLE = {
  overdue: "Fix login [redirect] bug", today: "Ship Discord bot", nodue: "Write docs",
  done: "Old finished thing", archived: "Archived thing", bobs: "Bob only task", foreign: "Other workspace task",
};
let sql: postgres.Sql;

async function seed() {
  sql = postgres(DB_URL!, { max: 2 });
  await sql`TRUNCATE users, workspaces RESTART IDENTITY CASCADE`;
  const users = [["A", "Alice"], ["B", "Bob"], ["V", "Vera Viewer"], ["X", "Xavier Outsider"]] as const;
  for (const [k, name] of users) await sql`INSERT INTO users (id, name, email) VALUES (${U[k]}, ${name}, ${`${k.toLowerCase()}@e2e.test`})`;
  await sql`INSERT INTO workspaces (id, name, slug, owner_id) VALUES (${W}, 'Main', 'main', ${U.A}), (${W2}, 'Other', 'other', ${U.X}), (${W3}, 'Third', 'third', ${U.A})`;
  await sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
    (${W}, ${U.A}, 'owner'), (${W}, ${U.B}, 'member'), (${W}, ${U.V}, 'viewer'), (${W2}, ${U.X}, 'owner'), (${W3}, ${U.A}, 'owner')`;
  await sql`INSERT INTO statuses (workspace_id, name, "order") VALUES (${W}, 'Not Fixed', 0), (${W}, 'Fixed', 1), (${W}, 'Done', 2)`;
  const [s1] = await sql`INSERT INTO spaces (workspace_id, name) VALUES (${W}, 'Eng') RETURNING id`;
  const [s2] = await sql`INSERT INTO spaces (workspace_id, name) VALUES (${W2}, 'Theirs') RETURNING id`;
  const [l1] = await sql`INSERT INTO lists (space_id, name) VALUES (${s1.id}, 'Sprint 15') RETURNING id`;
  const [l2] = await sql`INSERT INTO lists (space_id, name) VALUES (${s2.id}, 'Theirs') RETURNING id`;
  const task = (id: string, list: string, title: string, status: string, priority: string, due: string | null, archived = false) =>
    sql`INSERT INTO tasks (id, list_id, creator_id, title, status, priority, due_date, archived_at)
        VALUES (${id}, ${list}, ${U.A}, ${title}, ${status}, ${priority},
                ${due === null ? null : sql.unsafe(due)}, ${archived ? sql`timezone('utc', now())` : null})`;
  // Dates are naive-UTC, as the app stores them.
  await task(T.overdue, l1.id, TITLE.overdue, "not_fixed", "urgent", "timezone('utc', now()) - interval '1 day'");
  await task(T.today, l1.id, TITLE.today, "todo", "high", "date_trunc('day', timezone('utc', now())) + interval '23 hours'");
  await task(T.nodue, l1.id, TITLE.nodue, "in_progress", "low", null);
  await task(T.done, l1.id, TITLE.done, "done", "medium", "timezone('utc', now()) - interval '1 day'");
  await task(T.archived, l1.id, TITLE.archived, "todo", "medium", null, true);
  await task(T.bobs, l1.id, TITLE.bobs, "todo", "medium", null);
  await task(T.foreign, l2.id, TITLE.foreign, "todo", "medium", null);
  for (const t of [T.overdue, T.today, T.nodue, T.done, T.archived]) await sql`INSERT INTO task_assignees (task_id, user_id) VALUES (${t}, ${U.A})`;
  await sql`INSERT INTO task_assignees (task_id, user_id) VALUES (${T.bobs}, ${U.B}), (${T.overdue}, ${U.B}), (${T.foreign}, ${U.X})`;

  await sql`INSERT INTO workspace_discord_guilds (workspace_id, guild_id, guild_name, timezone) VALUES (${W}, ${GUILD}, 'Main server', 'UTC')`;
  await sql`INSERT INTO user_discord_accounts (user_id, discord_user_id, discord_username) VALUES (${U.A}, ${DISCORD_A}, 'Alice')`;
  const hash = (k: string) => createHash("sha256").update(k).digest("hex");
  await sql`INSERT INTO api_keys (user_id, key_hash, name) VALUES (${U.A}, ${hash(KEY_A)}, 'e2e'), (${U.V}, ${hash(KEY_V)}, 'e2e')`;

  // Old-style task reminders: one stale (backlog) and one just due.
  await sql`INSERT INTO reminders (task_id, user_id, remind_at) VALUES
    (${T.overdue}, ${U.A}, timezone('utc', now()) - interval '2 days'),
    (${T.today},   ${U.A}, timezone('utc', now()) - interval '1 minute')`;
}

// ── Suite ────────────────────────────────────────────────────────────────────
describe.skipIf(!DB_URL)("Discord integration (e2e)", () => {
  beforeAll(async () => {
    await startMock();
    await seed();
    // Two instances = a rolling deploy's overlap, for the whole suite.
    await Promise.all([startServer(PORT_A), startServer(PORT_B)]);
  });
  afterAll(async () => {
    for (const s of servers) s.kill("SIGTERM");
    await sql?.end();
    mock?.close();
  });

  describe("request verification", () => {
    it("rejects a missing signature", async () => expect((await interact({ type: 1 }, { sig: null })).status).toBe(401));
    it("rejects a forged signature", async () => expect((await interact({ type: 1 }, { sig: "ab".repeat(64) })).status).toBe(401));
    it("rejects a body altered after signing", async () =>
      expect((await interact({ type: 2, data: { name: "tasks" } }, { tamper: true })).status).toBe(401));
    it("rejects a replayed request (stale timestamp)", async () =>
      expect((await interact({ type: 1 }, { ts: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401));
    it("answers a valid PING with PONG", async () => {
      const r = await interact({ type: 1 });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ type: 1 });
    });
    it("leaves JSON parsing on every other route untouched", async () => {
      const res = await fetch(`${API_A}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Email and password are required" });
    });
  });

  describe("/tasks", () => {
    it("lists only the invoker's open tasks in this workspace, overdue first, privately", async () => {
      const r = await command("tasks");
      expect(r.body.type).toBe(4);
      expect(r.body.data.flags).toBe(64);
      expect(r.body.data.allowed_mentions).toEqual({ parse: [] });
      const d: string = r.body.data.embeds[0].description;
      for (const t of ["Ship Discord bot", "Write docs"]) expect(d).toContain(t);
      expect(d).toContain("Fix login \\[redirect\\] bug"); // markdown-escaped
      for (const t of [TITLE.done, TITLE.archived, TITLE.bobs, TITLE.foreign]) expect(d).not.toContain(t);
      const lines = d.split("\n");
      expect(lines[0]).toContain("Fix login");
      expect(lines[0]).toContain("⚠️");
      expect(lines[0]).toContain("Not Fixed");
      expect(r.body.data.embeds[0].footer.text).toBe("3 tasks");
      expect(d).toContain(`${APP_URL}/dashboard/workspaces/${W}/tasks/${T.overdue}`);
    });
    it("filters by due date", async () => {
      const r = await command("tasks", [{ name: "due", type: 3, value: "overdue" }]);
      const d: string = r.body.data.embeds[0].description;
      expect(d.split("\n")).toHaveLength(1);
      expect(d).toContain("Fix login");
    });
    it("filters by status slug", async () => {
      const r = await command("tasks", [{ name: "status", type: 3, value: "in_progress" }]);
      expect(r.body.data.embeds[0].description.split("\n")).toHaveLength(1);
      expect(r.body.data.embeds[0].description).toContain("Write docs");
    });
    it("posts publicly when share is set", async () => {
      expect((await command("tasks", [{ name: "share", type: 5, value: true }])).body.data.flags).toBe(0);
    });
    it("asks unlinked Discord users to link, with a button", async () => {
      const r = await command("tasks", [], STRANGER);
      expect(r.body.data.content).toContain("Link your Discord account");
      expect(r.body.data.components[0].components[0].url).toBe(`${APP_URL}/dashboard/settings?tab=integrations`);
    });
    it("explains when the server isn't connected", async () => {
      expect((await command("tasks", [], DISCORD_A, "999999999999999999")).body.data.content).toContain("isn't connected");
    });
  });

  describe("/task", () => {
    it("renders a card from a link whose path also contains the workspace id", async () => {
      const r = await command("task", [{ name: "link", type: 3, value: `${APP_URL}/dashboard/workspaces/${W}/tasks/${T.overdue}` }]);
      const e = r.body.data.embeds[0];
      expect(e.title).toBe(TITLE.overdue);
      const f = Object.fromEntries(e.fields.map((x: any) => [x.name, x.value]));
      expect(f.Status).toBe("Not Fixed");
      expect(f.Priority).toBe("🔴 Urgent");
      expect(f.Assignees).toContain(`<@${DISCORD_A}>`); // linked → mention
      expect(f.Assignees).toContain("Bob"); // unlinked → name
      expect(f.List).toBe("Sprint 15");
      expect(r.body.data.components[0].components[0].url).toBe(`${APP_URL}/dashboard/workspaces/${W}/tasks/${T.overdue}`);
      expect(r.body.data.allowed_mentions).toEqual({ parse: [] }); // renders the mention, never pings
    });
    it("won't reveal tasks from another workspace", async () => {
      const r = await command("task", [{ name: "link", type: 3, value: T.foreign }]);
      expect(r.body.data.content).toContain("couldn't find");
      expect(JSON.stringify(r.body)).not.toContain(TITLE.foreign);
    });
    it("rejects things that aren't task links", async () => {
      expect((await command("task", [{ name: "link", type: 3, value: "not a link" }])).body.data.content).toContain("doesn't look like");
    });
  });

  it("autocompletes open workspace statuses, not closed ones", async () => {
    const r = await interact({ type: 4, guild_id: GUILD, member: { user: { id: DISCORD_A } }, data: { name: "tasks", options: [{ name: "status", type: 3, value: "fix", focused: true }] } });
    expect(r.body.type).toBe(8);
    expect(r.body.data.choices).toEqual(expect.arrayContaining([{ name: "Not Fixed", value: "not_fixed" }, { name: "Fixed", value: "fixed" }]));
    const all = await interact({ type: 4, guild_id: GUILD, member: { user: { id: DISCORD_A } }, data: { name: "tasks", options: [{ name: "status", type: 3, value: "", focused: true }] } });
    expect(all.body.data.choices.map((c: any) => c.value)).not.toContain("done");
  });

  describe("dashboard API", () => {
    it("reports the connection", async () => {
      const r = await (await api(`/workspaces/${W}/discord`)).json();
      expect(r.configured).toBe(true);
      expect(r.guild).toMatchObject({ id: GUILD, name: "Main server", timezone: "UTC" });
      expect(r.canManageConnection).toBe(true);
      expect(r.canManageReminders).toBe(true);
      const viewer = await (await api(`/workspaces/${W}/discord`, { key: KEY_V })).json();
      expect(viewer).toMatchObject({ canManageConnection: false, canManageReminders: false });
    });
    it("lists only postable channels and mentionable roles", async () => {
      expect((await (await api(`/workspaces/${W}/discord/channels`)).json()).channels).toEqual([{ id: CHANNEL, name: "general" }]);
      expect((await (await api(`/workspaces/${W}/discord/roles`)).json()).roles.map((r: any) => r.id)).toEqual([ROLE]);
    });
    it("shows which members have linked Discord", async () => {
      const { members } = await (await api(`/workspaces/${W}/discord/members`)).json();
      expect(members.find((m: any) => m.userId === U.A).discordLinked).toBe(true);
      expect(members.find((m: any) => m.userId === U.B).discordLinked).toBe(false);
    });

    const valid = { name: "Standup", channelId: CHANNEL, message: "Standup in 5!", schedule: { kind: "daily", times: ["09:00"], timezone: "Asia/Kolkata" } };
    it.each([
      ["a voice channel", { channelId: VOICE }, "text channel"],
      ["a channel outside the server", { channelId: "999999999999999999" }, "text channel"],
      ["tagging a non-member", { mentionUserIds: [U.X] }, "aren't members"],
      ["a role outside the server", { mentionRoleIds: ["888888888888888888"] }, "roles"],
      ["a task from another workspace", { taskId: T.foreign }, "isn't in this workspace"],
      ["a one-time reminder in the past", { schedule: { kind: "once", at: "2020-01-01T09:00", timezone: "UTC" } }, "already passed"],
      ["an invalid schedule", { schedule: { kind: "weekly", days: [], times: ["09:00"], timezone: "UTC" } }, "day"],
    ])("rejects %s", async (_n, patch, msg) => {
      const res = await api(`/workspaces/${W}/discord/reminders`, { method: "POST", body: { ...valid, ...patch } });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain(msg);
    });
    it("forbids viewers from creating reminders", async () => {
      expect((await api(`/workspaces/${W}/discord/reminders`, { method: "POST", key: KEY_V, body: valid })).status).toBe(403);
    });
    it("forbids non-members entirely", async () => {
      expect((await api(`/workspaces/${W2}/discord/reminders`)).status).toBe(403);
    });
    it("creates a valid reminder with its next run computed", async () => {
      const res = await api(`/workspaces/${W}/discord/reminders`, { method: "POST", body: valid });
      expect(res.status).toBe(201);
      const { reminder } = await res.json();
      expect(new Date(reminder.nextRunAt).getTime()).toBeGreaterThan(Date.now());
      expect(reminder.scheduleSummary).toBe("Daily at 09:00 (Asia/Kolkata)");
      await api(`/workspaces/${W}/discord/reminders/${reminder.id}`, { method: "DELETE" });
    });
  });

  describe("scheduler (two instances running)", () => {
    const create = async (body: object) => (await (await api(`/workspaces/${W}/discord/reminders`, { method: "POST", body })).json()).reminder;
    const forceDue = (id: string, secondsAgo: number) =>
      sql`UPDATE discord_reminders SET next_run_at = now() - make_interval(secs => ${secondsAgo}) WHERE id = ${id}`;
    const row = async (id: string) => (await sql`SELECT * FROM discord_reminders WHERE id = ${id}`)[0];

    it("sends a due reminder exactly once, with the right mentions", async () => {
      const r = await create({
        name: "Mentions", channelId: CHANNEL, message: "ONCE-ONLY check", mentionUserIds: [U.A, U.B],
        mentionRoleIds: [ROLE], mentionHere: true, taskId: T.today,
        schedule: { kind: "daily", times: ["09:00"], timezone: "UTC" },
      });
      await forceDue(r.id, 5);
      const mine = () => messagesTo(CHANNEL).filter((c) => c.body.content.includes("ONCE-ONLY check"));
      expect(await waitFor(() => mine().length > 0)).toBe(true);
      await new Promise((res) => setTimeout(res, 3000)); // several more ticks on both instances
      expect(mine()).toHaveLength(1);

      const msg = mine()[0].body;
      expect(msg.content).toContain("@here");
      expect(msg.content).toContain(`<@&${ROLE}>`);
      expect(msg.content).toContain(`<@${DISCORD_A}>`);
      expect(msg.allowed_mentions).toEqual({ users: [DISCORD_A], roles: [ROLE], parse: ["everyone"] });
      expect(msg.embeds[0].url).toBe(`${APP_URL}/dashboard/workspaces/${W}/tasks/${T.today}`);

      const after = await row(r.id);
      expect(after.last_status).toBe("sent");
      expect(new Date(after.next_run_at).getTime()).toBeGreaterThan(Date.now());
      await sql`DELETE FROM discord_reminders WHERE id = ${r.id}`;
    });

    it("skips (does not send) an occurrence missed by more than 15 minutes", async () => {
      const r = await create({ name: "Late", channelId: CHANNEL, message: "LATE check", schedule: { kind: "daily", times: ["09:00"], timezone: "UTC" } });
      await forceDue(r.id, 30 * 60);
      expect(await waitFor(async () => (await row(r.id)).last_status === "skipped")).toBe(true);
      expect(messagesTo(CHANNEL).filter((c) => c.body.content.includes("LATE check"))).toHaveLength(0);
      expect(new Date((await row(r.id)).next_run_at).getTime()).toBeGreaterThan(Date.now());
      await sql`DELETE FROM discord_reminders WHERE id = ${r.id}`;
    });

    it("fires a one-time reminder once and then retires it", async () => {
      const at = new Date(Date.now() + 86400_000).toISOString().slice(0, 16); // tomorrow, UTC
      const r = await create({ name: "Once", channelId: CHANNEL, message: "ONE-TIME check", schedule: { kind: "once", at, timezone: "UTC" } });
      await forceDue(r.id, 2);
      expect(await waitFor(async () => (await row(r.id)).last_status === "sent")).toBe(true);
      const after = await row(r.id);
      expect(after.enabled).toBe(false);
      expect(after.next_run_at).toBeNull();
      await new Promise((res) => setTimeout(res, 2000));
      expect(messagesTo(CHANNEL).filter((c) => c.body.content.includes("ONE-TIME check"))).toHaveLength(1);
      await sql`DELETE FROM discord_reminders WHERE id = ${r.id}`;
    });

    it("never double-sends when schedulers race on the same due reminder", async () => {
      // Run the real compiled scheduler in-process too, so calls genuinely
      // overlap (the background instances' ticks rarely coincide).
      Object.assign(process.env, {
        DATABASE_URL: DB_URL, NEXTAUTH_SECRET: SECRET, NEXT_PUBLIC_APP_URL: APP_URL,
        DISCORD_APPLICATION_ID: APP_ID, DISCORD_PUBLIC_KEY: PUB_HEX, DISCORD_BOT_TOKEN: "bot-token",
        DISCORD_CLIENT_SECRET: "client-secret", DISCORD_API_BASE: `http://127.0.0.1:${MOCK_PORT}/api/v10`,
      });
      const { runDiscordReminders } = await import(pathToFileURL(`${ROOT}dist/lib/scheduler.js`).href);
      const r = await create({ name: "Race", channelId: CHANNEL, message: "RACE check", schedule: { kind: "daily", times: ["09:00"], timezone: "UTC" } });
      const sent = () => messagesTo(CHANNEL).filter((c) => c.body.content.includes("RACE check")).length;
      const ROUNDS = 25;
      for (let i = 0; i < ROUNDS; i++) {
        await forceDue(r.id, 1);
        await Promise.all([runDiscordReminders(), runDiscordReminders(), runDiscordReminders()]);
        // Each armed occurrence is sent by exactly one of the 5 schedulers.
        await waitFor(() => sent() >= i + 1, 3000);
        expect(sent()).toBe(i + 1);
      }
      await new Promise((res) => setTimeout(res, 1500));
      expect(sent()).toBe(ROUNDS);
      await sql`DELETE FROM discord_reminders WHERE id = ${r.id}`;
    });

    it("test-send posts immediately and reports unlinked people", async () => {
      const r = await create({ name: "T", channelId: CHANNEL, message: "TEST-SEND check", mentionUserIds: [U.A, U.B], schedule: { kind: "daily", times: ["09:00"], timezone: "UTC" } });
      const res = await api(`/workspaces/${W}/discord/reminders/${r.id}/test`, { method: "POST" });
      expect(res.status).toBe(200);
      expect((await res.json()).unlinkedUserIds).toEqual([U.B]);
      const m = messagesTo(CHANNEL).filter((c) => c.body.content.includes("TEST-SEND check"));
      expect(m).toHaveLength(1);
      expect(m[0].body.content).toContain("Test reminder");
      expect((await row(r.id)).last_status).toBeNull(); // schedule untouched
      await sql`DELETE FROM discord_reminders WHERE id = ${r.id}`;
    });
  });

  describe("existing in-app task reminders", () => {
    it("skips the stale backlog silently and notifies the just-due one exactly once", async () => {
      expect(await waitFor(async () => (await sql`SELECT count(*)::int AS n FROM reminders WHERE sent = false`)[0].n === 0)).toBe(true);
      await new Promise((res) => setTimeout(res, 2000)); // both instances tick more
      const notes = await sql`SELECT title FROM notifications WHERE user_id = ${U.A} ORDER BY created_at`;
      expect(notes.map((n) => n.title)).toEqual([`Reminder: ${TITLE.today}`]);
    });
  });

  describe("OAuth flows", () => {
    const location = (res: Response) => res.headers.get("location") ?? "";
    const stateFrom = (url: string) => new URL(url).searchParams.get("state")!;

    it("link/start redirects to Discord with the exact redirect URI", async () => {
      const res = await api("/discord/link/start", { cookie: await sessionCookie(U.B) });
      expect(res.status).toBe(302);
      const u = new URL(location(res));
      expect(u.origin + u.pathname).toBe("https://discord.com/oauth2/authorize");
      expect(u.searchParams.get("client_id")).toBe(APP_ID);
      expect(u.searchParams.get("scope")).toBe("identify");
      expect(u.searchParams.get("redirect_uri")).toBe(`${API_A}/discord/oauth/callback`);
    });
    it("link/start sends signed-out users to log in", async () => {
      const res = await api("/discord/link/start", { key: "" });
      expect(location(res)).toContain(`${APP_URL}/login`);
    });
    it("rejects a forged or expired state", async () => {
      const res = await api("/discord/oauth/callback?code=x&state=forged.state", { cookie: await sessionCookie(U.B) });
      expect(location(res)).toContain("discord_error=expired");
    });
    it("rejects completing someone else's flow (session mismatch)", async () => {
      const start = await api("/discord/link/start", { cookie: await sessionCookie(U.B) });
      const res = await api(`/discord/oauth/callback?code=x&state=${stateFrom(location(start))}`, { cookie: await sessionCookie(U.A) });
      expect(location(res)).toContain("discord_error=session_mismatch");
    });
    it("refuses a Discord account already linked to another user", async () => {
      mockMe = { id: DISCORD_A, username: "alice", global_name: "Alice" };
      const start = await api("/discord/link/start", { cookie: await sessionCookie(U.B) });
      const res = await api(`/discord/oauth/callback?code=x&state=${stateFrom(location(start))}`, { cookie: await sessionCookie(U.B) });
      expect(location(res)).toContain("discord_error=discord_in_use");
    });
    it("links an account end to end", async () => {
      mockMe = { id: DISCORD_B, username: "bob", global_name: "Bob" };
      const start = await api("/discord/link/start", { cookie: await sessionCookie(U.B) });
      const res = await api(`/discord/oauth/callback?code=x&state=${stateFrom(location(start))}`, { cookie: await sessionCookie(U.B) });
      expect(location(res)).toBe(`${APP_URL}/dashboard/settings?tab=integrations&discord=linked`);
      const [link] = await sql`SELECT * FROM user_discord_accounts WHERE user_id = ${U.B}`;
      expect(link.discord_user_id).toBe(DISCORD_B);
      // The exchange sent the same redirect_uri Discord authorized.
      const exchange = calls.filter((c) => c.path === "/oauth2/token").at(-1)!;
      expect(exchange.body.redirect_uri).toBe(`${API_A}/discord/oauth/callback`);
    });
    it("won't let a plain member install the bot", async () => {
      const res = await api(`/workspaces/${W}/discord/install/start`, { cookie: await sessionCookie(U.B) });
      expect(location(res)).toContain("discord_error=forbidden");
    });
    it("installs into a server and records the installer's timezone", async () => {
      mockMe = { id: DISCORD_A, username: "alice", global_name: "Alice" };
      mockTokenGuild = { id: NEW_GUILD, name: "New Server" };
      const start = await api(`/workspaces/${W3}/discord/install/start?tz=Asia%2FKolkata`, { cookie: await sessionCookie(U.A) });
      const u = new URL(location(start));
      expect(u.searchParams.get("scope")).toBe("identify bot applications.commands");
      expect(u.searchParams.get("permissions")).toBe(String(1024 + 2048 + 16384 + 131072));
      const res = await api(`/discord/oauth/callback?code=x&guild_id=${NEW_GUILD}&state=${stateFrom(u.toString())}`, { cookie: await sessionCookie(U.A) });
      expect(location(res)).toContain("discord=installed");
      const [g] = await sql`SELECT * FROM workspace_discord_guilds WHERE workspace_id = ${W3}`;
      expect(g).toMatchObject({ guild_id: NEW_GUILD, guild_name: "New Server", timezone: "Asia/Kolkata" });
    });
    it("won't bind a server that already belongs to another workspace", async () => {
      mockTokenGuild = { id: GUILD, name: "Main server" };
      const start = await api(`/workspaces/${W3}/discord/install/start`, { cookie: await sessionCookie(U.A) });
      const res = await api(`/discord/oauth/callback?code=x&state=${stateFrom(location(start))}`, { cookie: await sessionCookie(U.A) });
      expect(location(res)).toContain("discord_error=server_in_use");
      mockTokenGuild = undefined;
    });
  });

  it("registered the slash commands on startup", () => {
    const reg = calls.filter((c) => c.method === "PUT" && c.path === `/applications/${APP_ID}/commands`);
    expect(reg.length).toBeGreaterThanOrEqual(1);
    expect(reg[0].body.map((c: any) => c.name)).toEqual(["tasks", "task"]);
  });
});
