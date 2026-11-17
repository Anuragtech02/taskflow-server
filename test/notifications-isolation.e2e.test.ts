/**
 * E2E: notifications never cross a workspace boundary, and only reach the
 * people they concern. Real Postgres + the compiled server.
 *
 *   docker run -d --name tf-test-pg -e POSTGRES_USER=taskflow -e POSTGRES_PASSWORD=taskflow \
 *     -e POSTGRES_DB=taskflow -p 55450:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://taskflow:taskflow@localhost:55450/taskflow npx drizzle-kit push --force
 *   E2E_DATABASE_URL=postgresql://taskflow:taskflow@localhost:55450/taskflow npm run test:e2e
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DB_URL = process.env.E2E_DATABASE_URL;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 19323;
const API = `http://127.0.0.1:${PORT}`;
const CRON_KEY = "e2e-cron-key";

// Alice owns WA; Bob and Carol are members of WA. Xavier owns WB and has no
// access to WA. His name is one lowercase word so a plain-text "@xavier"
// matches the legacy mention lookup.
const U = { alice: randomUUID(), bob: randomUUID(), carol: randomUUID(), xavier: randomUUID() };
const KEY = { alice: "tfk_iso_alice", bob: "tfk_iso_bob", carol: "tfk_iso_carol", xavier: "tfk_iso_xavier" };
const WA = randomUUID(), WB = randomUUID();
const L = { a: randomUUID(), b: randomUUID() };
const T = { bobs: randomUUID(), carols: randomUUID(), plain: randomUUID(), theirs: randomUUID(), auto: randomUUID() };

let sql: postgres.Sql;
let server: ChildProcess;
const logs: string[] = [];

const api = (path: string, init: { method?: string; body?: unknown; key?: string } = {}) =>
  fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${init.key ?? KEY.alice}`,
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

const rowsFor = (userId: string) =>
  sql<{ type: string; title: string; entity_id: string | null }[]>`
    SELECT type, title, entity_id FROM notifications WHERE user_id = ${userId} ORDER BY created_at`;
const bell = async (key: string) => (await api("/notifications", { key })).json() as Promise<{
  notifications: { type: string; title: string }[]; unreadCount: number | string;
}>;
const comment = (taskId: string, content: unknown, key = KEY.alice) =>
  api(`/tasks/${taskId}/comments`, { method: "POST", key, body: { content: typeof content === "string" ? content : JSON.stringify(content) } });
/** A comment as the editor saves it: TipTap JSON with mention nodes. */
const doc = (text: string, mentionIds: string[] = []) => ({
  type: "doc",
  content: [{
    type: "paragraph",
    content: [
      { type: "text", text },
      ...mentionIds.map((id) => ({ type: "mention", attrs: { id, label: "someone" } })),
    ],
  }],
});
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

/** Subscribe to a workspace's live stream; collects every named event. */
async function listen(workspaceId: string, key: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${API}/sse?workspaceId=${workspaceId}`, {
    headers: { authorization: `Bearer ${key}` }, signal: ctrl.signal,
  });
  const events: { type: string; data: any }[] = [];
  let ended = false;
  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const type = /^event: (.+)$/m.exec(chunk)?.[1];
            const data = /^data: (.+)$/m.exec(chunk)?.[1];
            if (type && data) events.push({ type, data: JSON.parse(data) });
          }
        }
      } catch { /* aborted */ }
      ended = true;
    })();
  }
  return { status: res.status, events, of: (t: string) => events.filter((e) => e.type === t), ended: () => ended, close: () => ctrl.abort() };
}

async function seed() {
  sql = postgres(DB_URL!, { max: 2 });
  await sql`TRUNCATE users, workspaces RESTART IDENTITY CASCADE`;
  await sql`INSERT INTO users (id, name, email, email_notifications) VALUES
    (${U.alice}, 'Alice Admin', 'alice@iso.test', false), (${U.bob}, 'Bob Builder', 'bob@iso.test', false),
    (${U.carol}, 'Carol Contractor', 'carol@iso.test', false), (${U.xavier}, 'xavier', 'xavier@iso.test', false)`;
  await sql`INSERT INTO workspaces (id, name, slug, owner_id) VALUES (${WA}, 'Acme', 'acme', ${U.alice}), (${WB}, 'Other Co', 'other-co', ${U.xavier})`;
  await sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
    (${WA}, ${U.alice}, 'owner'), (${WA}, ${U.bob}, 'member'), (${WA}, ${U.carol}, 'member'), (${WB}, ${U.xavier}, 'owner')`;
  const [sa] = await sql`INSERT INTO spaces (workspace_id, name) VALUES (${WA}, 'Eng') RETURNING id`;
  const [sb] = await sql`INSERT INTO spaces (workspace_id, name) VALUES (${WB}, 'Theirs') RETURNING id`;
  await sql`INSERT INTO lists (id, space_id, name) VALUES (${L.a}, ${sa.id}, 'Backlog'), (${L.b}, ${sb.id}, 'Theirs')`;
  const t = (id: string, list: string, title: string, creator: string) =>
    sql`INSERT INTO tasks (id, list_id, creator_id, title, status) VALUES (${id}, ${list}, ${creator}, ${title}, 'todo')`;
  await t(T.bobs, L.a, "Secret launch plan", U.alice);      // assigned to Bob
  await t(T.carols, L.a, "Contractor handover", U.carol);   // created by + assigned to Carol
  await t(T.plain, L.a, "Nobody's task", U.alice);          // no assignees
  await t(T.auto, L.a, "Automation target", U.alice);
  await t(T.theirs, L.b, "Other company task", U.xavier);
  await sql`INSERT INTO task_assignees (task_id, user_id) VALUES (${T.bobs}, ${U.bob}), (${T.carols}, ${U.carol})`;
  const hash = (k: string) => createHash("sha256").update(k).digest("hex");
  for (const [name, id] of Object.entries(U)) {
    await sql`INSERT INTO api_keys (user_id, key_hash, name) VALUES (${id}, ${hash(KEY[name as keyof typeof KEY])}, 'e2e')`;
  }
}

describe.skipIf(!DB_URL)("notification isolation (e2e)", () => {
  beforeAll(async () => {
    await seed();
    server = spawn("node", ["dist/index.js"], {
      cwd: ROOT,
      env: {
        ...process.env, NODE_ENV: "test", PORT: String(PORT), HOST: "127.0.0.1", DATABASE_URL: DB_URL,
        NEXTAUTH_SECRET: "e2e-secret", CRON_API_KEY: CRON_KEY, RESEND_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout!.on("data", (d) => logs.push(String(d)));
    server.stderr!.on("data", (d) => logs.push(String(d)));
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`${API}/health`)).ok) return; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`server didn't start:\n${logs.join("").slice(-2000)}`);
  });
  afterAll(async () => { server?.kill("SIGTERM"); await sql?.end(); });

  describe("live stream", () => {
    it("refuses a subscription to a workspace you don't belong to", async () => {
      const s = await listen(WA, KEY.xavier);
      expect(s.status).toBe(403);
      s.close();
    });

    it("delivers a workspace's task events only inside that workspace", async () => {
      const bob = await listen(WA, KEY.bob), xavier = await listen(WB, KEY.xavier);
      await settle();
      expect((await api(`/tasks/${T.plain}`, { method: "PATCH", body: { priority: "high" } })).status).toBe(200);
      await settle();
      expect(bob.of("task_updated")).toHaveLength(1);
      expect(xavier.of("task_updated")).toHaveLength(0);
      expect(xavier.of("notification")).toHaveLength(0);
      bob.close(); xavier.close();
    });

    it("says who an update concerns: the assignees and creator, never the person who made it", async () => {
      const bob = await listen(WA, KEY.bob);
      await settle();
      await api(`/tasks/${T.bobs}`, { method: "PATCH", body: { priority: "urgent" } });   // Alice (creator) edits Bob's task
      await api(`/tasks/${T.plain}`, { method: "PATCH", body: { priority: "low" } });     // Alice edits her own unassigned task
      await api(`/tasks/${T.carols}`, { method: "PATCH", key: KEY.bob, body: { priority: "low" } }); // Bob edits Carol's task
      await settle();
      const byTask = Object.fromEntries(bob.of("task_updated").map((e) => [e.data.task.id, e.data.concerns]));
      expect(byTask[T.bobs]).toEqual([U.bob]);
      expect(byTask[T.plain]).toEqual([]);
      expect(byTask[T.carols]).toEqual([U.carol]);
      bob.close();
    });
  });

  describe("comments and mentions", () => {
    it("a comment notifies the task's assignee, not the commenter or uninvolved members", async () => {
      expect((await comment(T.bobs, doc("Looks good"))).status).toBe(201);
      expect((await rowsFor(U.bob)).map((n) => n.type)).toEqual(["comment_added"]);
      expect(await rowsFor(U.alice)).toHaveLength(0);
      expect(await rowsFor(U.carol)).toHaveLength(0);
      expect(await rowsFor(U.xavier)).toHaveLength(0);
    });

    it("typing @name of someone in another workspace does not notify them", async () => {
      expect((await comment(T.plain, "ping @xavier about this")).status).toBe(201);
      expect((await comment(T.plain, doc("ping @xavier about this"))).status).toBe(201);
      expect(await rowsFor(U.xavier)).toHaveLength(0);
    });

    it("a forged mention of an outsider's user id does not notify them", async () => {
      expect((await comment(T.plain, doc("hello ", [U.xavier]))).status).toBe(201);
      expect(await rowsFor(U.xavier)).toHaveLength(0);
    });

    it("mentioning a workspace member notifies exactly that member, once", async () => {
      await sql`DELETE FROM notifications`;
      expect((await comment(T.plain, doc("can you check ", [U.carol, U.carol]))).status).toBe(201);
      const carol = await rowsFor(U.carol);
      expect(carol.map((n) => n.type)).toEqual(["mention"]);
      expect(carol[0].entity_id).toBe(T.plain);
      expect(await rowsFor(U.bob)).toHaveLength(0);
    });

    it("a mentioned assignee gets the mention, not a second 'new comment' notification", async () => {
      await sql`DELETE FROM notifications`;
      expect((await comment(T.bobs, doc("over to you ", [U.bob]))).status).toBe(201);
      expect((await rowsFor(U.bob)).map((n) => n.type)).toEqual(["mention"]);
    });

    it("mentioning yourself notifies nobody", async () => {
      await sql`DELETE FROM notifications`;
      expect((await comment(T.plain, doc("note to self ", [U.alice]))).status).toBe(201);
      expect(await rowsFor(U.alice)).toHaveLength(0);
    });

    it("the bell only lists your own notifications", async () => {
      await sql`DELETE FROM notifications`;
      await comment(T.bobs, doc("for bob"));
      expect((await bell(KEY.bob)).notifications).toHaveLength(1);
      expect((await bell(KEY.carol)).notifications).toHaveLength(0);
      expect((await bell(KEY.xavier)).notifications).toHaveLength(0);
    });

    it("you cannot hand-craft a notification for someone outside your workspaces", async () => {
      const r = await api("/notifications", { method: "POST", body: { userId: U.xavier, type: "mention", title: "psst" } });
      expect(r.status).toBe(403);
      expect(await rowsFor(U.xavier)).toHaveLength(0);
    });
  });

  describe("automations", () => {
    const automation = (actionType: string, actionConfig: Record<string, unknown>) =>
      api(`/workspaces/${WA}/automations`, {
        method: "POST",
        body: { name: `e2e ${actionType}`, triggerType: "status_change", triggerConfig: { fromStatus: "todo", toStatus: "in_progress" }, actionType, actionConfig },
      });

    it("cannot notify or assign a user who isn't in the workspace", async () => {
      await sql`DELETE FROM notifications`;
      await automation("send_notification", { userId: U.xavier, title: "Leaked from Acme" });
      await automation("assign_user", { userId: U.xavier });
      await automation("send_notification", { userId: U.bob, title: "Automation says hi" });
      expect((await api(`/tasks/${T.auto}`, { method: "PATCH", body: { status: "in_progress" } })).status).toBe(200);
      await settle();
      expect(await rowsFor(U.xavier)).toHaveLength(0);
      expect(await sql`SELECT 1 FROM task_assignees WHERE task_id = ${T.auto} AND user_id = ${U.xavier}`).toHaveLength(0);
      // ...while a member still gets theirs.
      expect((await rowsFor(U.bob)).map((n) => n.title)).toEqual(["Automation says hi"]);
    });
  });

  describe("after someone is removed from a workspace", () => {
    it("their open live stream is closed, and they stop getting anything from it", async () => {
      await sql`DELETE FROM notifications`;
      // Carol has history in WA: a comment notification on the task she created.
      await comment(T.carols, doc("before removal"));
      expect((await bell(KEY.carol)).notifications).toHaveLength(1);
      // A due reminder she set while she was a member.
      await sql`INSERT INTO reminders (task_id, user_id, remind_at, type) VALUES (${T.carols}, ${U.carol}, now() - interval '1 minute', 'notification')`;

      const carol = await listen(WA, KEY.carol);
      await settle();
      expect(carol.status).toBe(200);

      expect((await api(`/workspaces/${WA}/members/${U.carol}`, { method: "DELETE" })).status).toBe(200);
      await settle();
      expect(carol.ended()).toBe(true);

      const seenBefore = carol.events.length;
      await api(`/tasks/${T.carols}`, { method: "PATCH", body: { priority: "urgent" } });
      await settle();
      expect(carol.events.length).toBe(seenBefore);
      expect((await listen(WA, KEY.carol)).status).toBe(403);
      carol.close();
    });

    it("comments on tasks they created or were assigned no longer notify them", async () => {
      const before = (await rowsFor(U.carol)).length;
      expect((await comment(T.carols, doc("after removal ", [U.carol]))).status).toBe(201);
      expect((await rowsFor(U.carol)).length).toBe(before);
    });

    it("a reminder they set earlier is not delivered", async () => {
      const before = (await rowsFor(U.carol)).length;
      const r = await fetch(`${API}/reminders/check`, { method: "POST", headers: { authorization: `Bearer ${CRON_KEY}` } });
      expect(r.status).toBe(200);
      expect((await rowsFor(U.carol)).length).toBe(before);
    });

    it("their bell no longer shows that workspace's old notifications", async () => {
      expect((await rowsFor(U.carol)).length).toBeGreaterThan(0); // still stored...
      const b = await bell(KEY.carol);
      expect(b.notifications).toHaveLength(0);                    // ...but not shown
      expect(Number(b.unreadCount)).toBe(0);
    });
  });
});
