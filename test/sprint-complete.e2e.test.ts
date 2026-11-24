/**
 * E2E: completing a sprint in ONE request — every incomplete task moves and
 * the sprint closes in a single transaction. Real Postgres + the compiled server.
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
const PORT = 19324;
const API = `http://127.0.0.1:${PORT}`;

const U = { owner: randomUUID(), member: randomUUID(), outsider: randomUUID() };
const KEY = { owner: "tfk_sc_owner", member: "tfk_sc_member", outsider: "tfk_sc_outsider" };
const W = randomUUID(), W2 = randomUUID();
let SPACE: string, SPACE2: string, BACKLOG: string, GENERAL: string;

let sql: postgres.Sql;
let server: ChildProcess;
const logs: string[] = [];

const api = (path: string, init: { method?: string; body?: unknown; key?: string } = {}) =>
  fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${init.key ?? KEY.owner}`,
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
const complete = async (sprintId: string, body: unknown, key?: string) => {
  const r = await api(`/sprints/${sprintId}/complete`, { method: "POST", body, key });
  return { status: r.status, body: (await r.json()) as any };
};

/** A sprint with its own list; `statuses` become its tasks (in list + junction). */
async function makeSprint(name: string, statuses: (string | null)[], opts: { workspace?: string; space?: string; status?: string } = {}) {
  const id = randomUUID(), listId = randomUUID();
  const ws = opts.workspace ?? W, space = opts.space ?? SPACE;
  await sql`INSERT INTO sprints (id, workspace_id, space_id, name, start_date, end_date, status)
            VALUES (${id}, ${ws}, ${space}, ${name}, now() - interval '14 days', now() - interval '1 day', ${opts.status ?? "active"})`;
  await sql`INSERT INTO lists (id, space_id, name, kind, sprint_id) VALUES (${listId}, ${space}, ${name}, 'sprint', ${id})`;
  const taskIds: string[] = [];
  if (statuses.length > 0) {
    const rows = statuses.map((status, i) => ({ id: randomUUID(), list_id: listId, creator_id: U.owner, title: `${name} #${i}`, status }));
    for (let i = 0; i < rows.length; i += 500) await sql`INSERT INTO tasks ${sql(rows.slice(i, i + 500))}`;
    const links = rows.map((r) => ({ sprint_id: id, task_id: r.id }));
    for (let i = 0; i < links.length; i += 500) await sql`INSERT INTO sprint_tasks ${sql(links.slice(i, i + 500))}`;
    taskIds.push(...rows.map((r) => r.id));
  }
  return { id, listId, taskIds };
}
const where = async (taskIds: string[]) => {
  const rows = await sql<{ id: string; list_id: string; sprints: string[] }[]>`
    SELECT t.id, t.list_id, COALESCE(array_agg(st.sprint_id) FILTER (WHERE st.sprint_id IS NOT NULL), '{}') AS sprints
    FROM tasks t LEFT JOIN sprint_tasks st ON st.task_id = t.id WHERE t.id IN ${sql(taskIds)} GROUP BY t.id`;
  return new Map(rows.map((r) => [r.id, r]));
};
const sprintRow = async (id: string) =>
  (await sql`SELECT s.status, l.archived_at FROM sprints s JOIN lists l ON l.sprint_id = s.id WHERE s.id = ${id}`)[0];

async function seed() {
  sql = postgres(DB_URL!, { max: 2 });
  await sql`TRUNCATE users, workspaces RESTART IDENTITY CASCADE`;
  await sql`INSERT INTO users (id, name, email) VALUES (${U.owner}, 'Olga Owner', 'o@sc.test'), (${U.member}, 'Max Member', 'm@sc.test'), (${U.outsider}, 'Otto Outsider', 'x@sc.test')`;
  await sql`INSERT INTO workspaces (id, name, slug, owner_id) VALUES (${W}, 'Main', 'main-sc', ${U.owner}), (${W2}, 'Other', 'other-sc', ${U.outsider})`;
  await sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${W}, ${U.owner}, 'owner'), (${W}, ${U.member}, 'member'), (${W2}, ${U.outsider}, 'owner')`;
  SPACE = (await sql`INSERT INTO spaces (workspace_id, name) VALUES (${W}, 'Eng') RETURNING id`)[0].id;
  SPACE2 = (await sql`INSERT INTO spaces (workspace_id, name) VALUES (${W2}, 'Theirs') RETURNING id`)[0].id;
  BACKLOG = (await sql`INSERT INTO lists (space_id, name, kind) VALUES (${SPACE}, 'Backlog', 'backlog') RETURNING id`)[0].id;
  GENERAL = (await sql`INSERT INTO lists (space_id, name) VALUES (${SPACE}, 'Features') RETURNING id`)[0].id;
  const hash = (k: string) => createHash("sha256").update(k).digest("hex");
  for (const [name, id] of Object.entries(U)) {
    await sql`INSERT INTO api_keys (user_id, key_hash, name) VALUES (${id}, ${hash(KEY[name as keyof typeof KEY])}, 'e2e')`;
  }
}

describe.skipIf(!DB_URL)("complete sprint in one request (e2e)", () => {
  beforeAll(async () => {
    await seed();
    server = spawn("node", ["dist/index.js"], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: "test", PORT: String(PORT), HOST: "127.0.0.1", DATABASE_URL: DB_URL, NEXTAUTH_SECRET: "e2e-secret" },
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

  it("rolls incomplete tasks over to another sprint, leaves done ones, and completes the sprint", async () => {
    const from = await makeSprint("Roll 1", ["todo", "in_progress", "review", null, "done", "closed", "complete", "assigned_to_qa"]);
    const to = await makeSprint("Roll 2", ["todo"]);
    const r = await complete(from.id, { incompleteTasks: "rollover", targetSprintId: to.id });
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(5); // todo, in_progress, review, (no status), custom status
    expect(r.body.sprint.status).toBe("completed");

    const at = await where(from.taskIds);
    const [todo, prog, review, none, done, closed, completeT, custom] = from.taskIds.map((id) => at.get(id)!);
    for (const t of [todo, prog, review, none, custom]) {
      expect(t.list_id).toBe(to.listId);
      expect(t.sprints).toEqual([to.id]); // in the new sprint only
    }
    for (const t of [done, closed, completeT]) {
      expect(t.list_id).toBe(from.listId); // the frozen record
      expect(t.sprints).toEqual([from.id]);
    }
    // The target's own task is untouched; the source sprint's list is archived.
    expect((await where(to.taskIds)).get(to.taskIds[0])!.sprints).toEqual([to.id]);
    const s = await sprintRow(from.id);
    expect(s.status).toBe("completed");
    expect(s.archived_at).not.toBeNull();
    expect((await sprintRow(to.id)).status).toBe("active");
  });

  it("moves incomplete tasks to the Backlog list and out of every sprint", async () => {
    const from = await makeSprint("Back 1", ["todo", "done", "in_progress"]);
    const r = await complete(from.id, { incompleteTasks: "backlog" });
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(2);
    const at = await where(from.taskIds);
    expect(at.get(from.taskIds[0])).toMatchObject({ list_id: BACKLOG, sprints: [] });
    expect(at.get(from.taskIds[2])).toMatchObject({ list_id: BACKLOG, sprints: [] });
    expect(at.get(from.taskIds[1])).toMatchObject({ list_id: from.listId, sprints: [from.id] });
    expect((await sprintRow(from.id)).status).toBe("completed");
  });

  it("backlog: a task that is in the sprint but lives in an ordinary list stays in that list", async () => {
    const from = await makeSprint("Back 2", ["todo"]);
    const stray = randomUUID();
    await sql`INSERT INTO tasks (id, list_id, creator_id, title, status) VALUES (${stray}, ${GENERAL}, ${U.owner}, 'Lives in Features', 'todo')`;
    await sql`INSERT INTO sprint_tasks (sprint_id, task_id) VALUES (${from.id}, ${stray})`;
    const r = await complete(from.id, { incompleteTasks: "backlog" });
    expect(r.body.moved).toBe(2);
    expect((await where([stray])).get(stray)).toMatchObject({ list_id: GENERAL, sprints: [] });
  });

  it("completes a sprint that has nothing left to move", async () => {
    const from = await makeSprint("Empty", ["done", "done"]);
    const r = await complete(from.id, { incompleteTasks: "backlog" });
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(0);
    expect((await sprintRow(from.id)).status).toBe("completed");
  });

  it("handles a large sprint in one quick request", async () => {
    const statuses = Array.from({ length: 2500 }, (_, i) => (i % 5 === 0 ? "done" : "todo"));
    const from = await makeSprint("Big 1", statuses);
    const to = await makeSprint("Big 2", []);
    const t0 = Date.now();
    const r = await complete(from.id, { incompleteTasks: "rollover", targetSprintId: to.id });
    const ms = Date.now() - t0;
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(2000);
    expect(ms).toBeLessThan(5000);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM sprint_tasks WHERE sprint_id = ${to.id}`;
    const [{ m }] = await sql`SELECT count(*)::int AS m FROM tasks WHERE list_id = ${to.listId}`;
    const [{ left }] = await sql`SELECT count(*)::int AS left FROM sprint_tasks WHERE sprint_id = ${from.id}`;
    expect([n, m, left]).toEqual([2000, 2000, 500]);
    console.log(`  2500-task sprint completed in ${ms} ms`);
  });

  describe("refusals change nothing", () => {
    const untouched = async (s: { id: string; listId: string; taskIds: string[] }) => {
      const at = await where(s.taskIds);
      for (const id of s.taskIds) expect(at.get(id)).toMatchObject({ list_id: s.listId, sprints: [s.id] });
      expect((await sprintRow(s.id)).status).toBe("active");
    };

    it("a plain member cannot complete a sprint", async () => {
      const from = await makeSprint("Perm", ["todo"]);
      expect((await complete(from.id, { incompleteTasks: "backlog" }, KEY.member)).status).toBe(403);
      await untouched(from);
    });
    it("someone outside the workspace gets 404", async () => {
      const from = await makeSprint("Out", ["todo"]);
      expect((await complete(from.id, { incompleteTasks: "backlog" }, KEY.outsider)).status).toBe(404);
      await untouched(from);
    });
    it("cannot roll over into a sprint in another workspace", async () => {
      const from = await makeSprint("X-ws", ["todo"]);
      const foreign = await makeSprint("Foreign", [], { workspace: W2, space: SPACE2 });
      expect((await complete(from.id, { incompleteTasks: "rollover", targetSprintId: foreign.id })).status).toBe(404);
      await untouched(from);
    });
    it("cannot roll over into itself, a completed sprint, or nowhere", async () => {
      const from = await makeSprint("Bad target", ["todo"]);
      const closed = await makeSprint("Closed", [], { status: "completed" });
      expect((await complete(from.id, { incompleteTasks: "rollover", targetSprintId: from.id })).status).toBe(400);
      expect((await complete(from.id, { incompleteTasks: "rollover", targetSprintId: closed.id })).status).toBe(400);
      expect((await complete(from.id, { incompleteTasks: "rollover" })).status).toBe(400);
      expect((await complete(from.id, { incompleteTasks: "elsewhere" })).status).toBe(400);
      await untouched(from);
    });
    it("a sprint that is already completed is not processed twice", async () => {
      const from = await makeSprint("Twice", ["todo"]);
      const to = await makeSprint("Twice target", []);
      expect((await complete(from.id, { incompleteTasks: "rollover", targetSprintId: to.id })).status).toBe(200);
      // A task added to the closed sprint afterwards must not be swept by a repeat call.
      const late = randomUUID();
      await sql`INSERT INTO tasks (id, list_id, creator_id, title, status) VALUES (${late}, ${from.listId}, ${U.owner}, 'late', 'todo')`;
      await sql`INSERT INTO sprint_tasks (sprint_id, task_id) VALUES (${from.id}, ${late})`;
      expect((await complete(from.id, { incompleteTasks: "backlog" })).status).toBe(409);
      expect((await where([late])).get(late)).toMatchObject({ list_id: from.listId, sprints: [from.id] });
    });
    it("two simultaneous requests: exactly one wins", async () => {
      const from = await makeSprint("Race", Array.from({ length: 200 }, () => "todo"));
      const to = await makeSprint("Race target", []);
      const body = { incompleteTasks: "rollover", targetSprintId: to.id };
      const results = await Promise.all([complete(from.id, body), complete(from.id, body)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM sprint_tasks WHERE sprint_id = ${to.id}`;
      expect(n).toBe(200);
    });
  });
});
