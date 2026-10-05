/**
 * E2E: subtree cascade (status + move, any depth) and any-file-type uploads
 * with safe serving. Real Postgres + an S3-compatible stand-in + the compiled
 * server.
 *
 *   docker run -d --name tf-test-pg -e POSTGRES_USER=taskflow -e POSTGRES_PASSWORD=taskflow \
 *     -e POSTGRES_DB=taskflow -p 55432:5432 postgres:16-alpine
 *   docker run -d --name tf-test-s3 -p 59000:9090 adobe/s3mock
 *   DATABASE_URL=postgresql://taskflow:taskflow@localhost:55432/taskflow npx drizzle-kit push --force
 *   E2E_DATABASE_URL=postgresql://taskflow:taskflow@localhost:55432/taskflow E2E_S3_ENDPOINT=http://127.0.0.1:59000 npm run test:e2e
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DB_URL = process.env.E2E_DATABASE_URL;
const S3 = process.env.E2E_S3_ENDPOINT;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 19321;
const API = `http://127.0.0.1:${PORT}`;
const KEY_A = "tfk_cascade_alice", KEY_X = "tfk_cascade_outsider";

const U = { A: randomUUID(), X: randomUUID() };
const W = randomUUID(), W2 = randomUUID(), SP = randomUUID();
const L = { one: randomUUID(), two: randomUUID(), sprint: randomUUID(), foreign: randomUUID() };
const T = {
  P: randomUUID(), C1: randomUUID(), G1: randomUUID(), GG1: randomUUID(), C2: randomUUID(), C3: randomUUID(),
  Y: randomUUID(), Z: randomUUID(), XT: randomUUID(), U: randomUUID(),
};
let sql: postgres.Sql;
let server: ChildProcess;
const logs: string[] = [];

const api = (path: string, init: { method?: string; body?: unknown; key?: string; form?: FormData } = {}) =>
  fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${init.key ?? KEY_A}`,
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
const task = async (id: string) => (await sql`SELECT status, list_id, parent_task_id FROM tasks WHERE id = ${id}`)[0];

async function seed() {
  sql = postgres(DB_URL!, { max: 2 });
  await sql`TRUNCATE users, workspaces RESTART IDENTITY CASCADE`;
  await sql`INSERT INTO users (id, name, email) VALUES (${U.A}, 'Alice', 'a@cascade.test'), (${U.X}, 'Xavier', 'x@cascade.test')`;
  await sql`INSERT INTO workspaces (id, name, slug, owner_id) VALUES (${W}, 'Main', 'main', ${U.A}), (${W2}, 'Other', 'other', ${U.X})`;
  await sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${W}, ${U.A}, 'owner'), (${W2}, ${U.X}, 'owner')`;
  const [s1] = await sql`INSERT INTO spaces (workspace_id, name) VALUES (${W}, 'Eng') RETURNING id`;
  const [s2] = await sql`INSERT INTO spaces (workspace_id, name) VALUES (${W2}, 'Theirs') RETURNING id`;
  await sql`INSERT INTO sprints (id, workspace_id, space_id, name, start_date, end_date)
            VALUES (${SP}, ${W}, ${s1.id}, 'Sprint 16', now(), now() + interval '14 days')`;
  await sql`INSERT INTO lists (id, space_id, name) VALUES (${L.one}, ${s1.id}, 'Backlog'), (${L.two}, ${s1.id}, 'Later')`;
  await sql`INSERT INTO lists (id, space_id, name, kind, sprint_id) VALUES (${L.sprint}, ${s1.id}, 'Sprint 16', 'sprint', ${SP})`;
  await sql`INSERT INTO lists (id, space_id, name) VALUES (${L.foreign}, ${s2.id}, 'Theirs')`;
  const t = (id: string, list: string, title: string, parent: string | null, status = "todo") =>
    sql`INSERT INTO tasks (id, list_id, creator_id, title, status, parent_task_id) VALUES (${id}, ${list}, ${U.A}, ${title}, ${status}, ${parent})`;
  // P ─ C1 ─ G1 ─ GG1 (3 levels deep), P ─ C2 (already done), P ─ C3 (stranded in another list)
  await t(T.P, L.one, "Parent", null);
  await t(T.C1, L.one, "Child 1", T.P);
  await t(T.G1, L.one, "Grandchild", T.C1);
  await t(T.GG1, L.one, "Great-grandchild", T.G1);
  await t(T.C2, L.one, "Child 2 (done)", T.P, "done");
  await t(T.C3, L.two, "Child 3 (other list)", T.P);
  await t(T.U, L.one, "Unrelated", null);
  // Corrupted data: a parent cycle, and a task in ANOTHER workspace pointing at P.
  await t(T.Y, L.one, "Cycle Y", null);
  await t(T.Z, L.one, "Cycle Z", T.Y);
  await sql`UPDATE tasks SET parent_task_id = ${T.Z} WHERE id = ${T.Y}`;
  await t(T.XT, L.foreign, "Foreign child", T.P);
  const hash = (k: string) => createHash("sha256").update(k).digest("hex");
  await sql`INSERT INTO api_keys (user_id, key_hash, name) VALUES (${U.A}, ${hash(KEY_A)}, 'e2e'), (${U.X}, ${hash(KEY_X)}, 'e2e')`;
}

describe.skipIf(!DB_URL || !S3)("subtree cascade + any-file uploads (e2e)", () => {
  beforeAll(async () => {
    await seed();
    // Production's bucket already exists; a fresh S3 stand-in needs it created.
    await fetch(`${S3}/taskflow-e2e`, { method: "PUT" });
    server = spawn("node", ["dist/index.js"], {
      cwd: ROOT,
      env: {
        ...process.env, NODE_ENV: "test", PORT: String(PORT), HOST: "127.0.0.1", DATABASE_URL: DB_URL,
        NEXTAUTH_SECRET: "e2e-secret", S3_ENDPOINT: S3, S3_BUCKET: "taskflow-e2e",
        S3_ACCESS_KEY: "e2e", S3_SECRET_KEY: "e2e-secret-key", S3_REGION: "us-east-1",
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

  describe("POST /tasks/subtree-count", () => {
    const count = async (taskIds: string[], key?: string) => {
      const r = await api("/tasks/subtree-count", { method: "POST", body: { taskIds }, key });
      return { status: r.status, body: await r.json() };
    };
    it("counts every level, including a subtask stranded in another list", async () => {
      expect((await count([T.P])).body.total).toBe(5); // C1, G1, GG1, C2, C3
    });
    it("never counts a task from another workspace", async () => {
      expect((await count([T.P])).body.total).not.toBe(6);
    });
    it("counts DISTINCT subtasks across a bulk selection, excluding selected tasks", async () => {
      expect((await count([T.P, T.C1])).body.total).toBe(4); // G1, GG1, C2, C3 — C1 is selected, not counted
    });
    it("terminates on a corrupted parent cycle", async () => {
      expect((await count([T.Y])).body.total).toBe(1); // Z
    });
    it("is 0 for a leaf", async () => {
      expect((await count([T.GG1])).body.total).toBe(0);
    });
    it("hides tasks from non-members", async () => {
      expect((await count([T.P], KEY_X)).status).toBe(404);
    });
    it("rejects a selection spanning workspaces", async () => {
      expect((await count([T.P, T.XT], KEY_X)).status).toBe(400);
    });
  });

  describe("status cascade", () => {
    it("without the flag, only the task itself changes", async () => {
      const r = await (await api(`/tasks/${T.P}`, { method: "PATCH", body: { status: "in_progress" } })).json();
      expect(r.subtasksUpdated).toBe(0);
      expect((await task(T.P)).status).toBe("in_progress");
      expect((await task(T.C1)).status).toBe("todo");
    });

    it("with the flag, every level changes; foreign and unrelated tasks don't", async () => {
      const r = await (await api(`/tasks/${T.P}`, { method: "PATCH", body: { status: "review", applyToSubtasks: true } })).json();
      expect(r.task.status).toBe("review");
      expect(r.subtasksUpdated).toBe(5);
      for (const id of [T.C1, T.G1, T.GG1, T.C2, T.C3]) expect((await task(id)).status).toBe("review");
      expect((await task(T.XT)).status).toBe("todo");
      expect((await task(T.U)).status).toBe("todo");
    });

    it("records one history entry per changed subtask, and never the flag itself", async () => {
      const rows = await sql`SELECT task_id, field, old_value, new_value FROM task_activities WHERE new_value = 'review' AND field = 'status'`;
      expect(rows.map((r) => r.task_id).sort()).toEqual([T.P, T.C1, T.G1, T.GG1, T.C2, T.C3].sort());
      expect((await sql`SELECT count(*)::int AS n FROM task_activities WHERE field = 'applyToSubtasks'`)[0].n).toBe(0);
    });

    it("skips subtasks already at the target status (no history spam)", async () => {
      const before = (await sql`SELECT count(*)::int AS n FROM task_activities`)[0].n;
      const r = await (await api(`/tasks/${T.P}`, { method: "PATCH", body: { status: "review", applyToSubtasks: true } })).json();
      expect(r.subtasksUpdated).toBe(0);
      expect((await sql`SELECT count(*)::int AS n FROM task_activities`)[0].n).toBe(before);
    });

    it("survives a parent cycle", async () => {
      const res = await api(`/tasks/${T.Y}`, { method: "PATCH", body: { status: "done", applyToSubtasks: true } });
      expect(res.status).toBe(200);
      expect((await res.json()).subtasksUpdated).toBe(1);
      expect((await task(T.Z)).status).toBe("done");
    });
  });

  describe("move cascade", () => {
    it("without the flag, only the task moves", async () => {
      await api(`/tasks/${T.P}`, { method: "PATCH", body: { listId: L.two } });
      expect((await task(T.P)).list_id).toBe(L.two);
      expect((await task(T.C1)).list_id).toBe(L.one);
    });

    it("with the flag, the whole subtree moves as a unit into a sprint list", async () => {
      const r = await (await api(`/tasks/${T.P}`, { method: "PATCH", body: { listId: L.sprint, applyToSubtasks: true } })).json();
      expect(r.subtasksUpdated).toBe(5);
      for (const id of [T.P, T.C1, T.G1, T.GG1, T.C2, T.C3]) expect((await task(id)).list_id).toBe(L.sprint);
      // Hierarchy intact.
      expect((await task(T.GG1)).parent_task_id).toBe(T.G1);
      expect((await task(T.C1)).parent_task_id).toBe(T.P);
      // Foreign task untouched.
      expect((await task(T.XT)).list_id).toBe(L.foreign);
    });

    it("every moved subtask joins the sprint, not just the parent", async () => {
      const rows = await sql`SELECT task_id FROM sprint_tasks WHERE sprint_id = ${SP}`;
      expect(rows.map((r) => r.task_id).sort()).toEqual([T.P, T.C1, T.G1, T.GG1, T.C2, T.C3].sort());
    });

    it("still refuses moves into another workspace", async () => {
      const res = await api(`/tasks/${T.P}`, { method: "PATCH", body: { listId: L.foreign, applyToSubtasks: true } });
      expect(res.status).toBe(400);
      expect((await task(T.C1)).list_id).toBe(L.sprint);
    });
  });

  describe("sprint page: remove from sprint / move between sprints", () => {
    // SP: SPar ─ SChild ─ SGrand all in the sprint; SPar ─ SOut lives in a regular list.
    const S = { Par: randomUUID(), Child: randomUUID(), Grand: randomUUID(), Out: randomUUID() };
    const SP2 = randomUUID(), L2 = randomUUID(), SPX = randomUUID(), LX = randomUUID();
    const inSprint = async (id: string) =>
      (await sql`SELECT sprint_id FROM sprint_tasks WHERE task_id = ${id}`).map((r) => r.sprint_id);

    beforeAll(async () => {
      const [{ space_id }] = await sql`SELECT space_id FROM lists WHERE id = ${L.one}`;
      const [{ space_id: foreignSpace }] = await sql`SELECT space_id FROM lists WHERE id = ${L.foreign}`;
      await sql`INSERT INTO sprints (id, workspace_id, space_id, name, start_date, end_date) VALUES
        (${SP2}, ${W}, ${space_id}, 'Sprint 17', now(), now() + interval '14 days'),
        (${SPX}, ${W2}, ${foreignSpace}, 'Their sprint', now(), now() + interval '14 days')`;
      await sql`INSERT INTO lists (id, space_id, name, kind, sprint_id) VALUES
        (${L2}, ${space_id}, 'Sprint 17', 'sprint', ${SP2}), (${LX}, ${foreignSpace}, 'Their sprint', 'sprint', ${SPX})`;
    });
    beforeEach(async () => {
      await sql`DELETE FROM tasks WHERE id IN ${sql(Object.values(S))}`;
      const t = (id: string, list: string, title: string, parent: string | null) =>
        sql`INSERT INTO tasks (id, list_id, creator_id, title, status, parent_task_id) VALUES (${id}, ${list}, ${U.A}, ${title}, 'todo', ${parent})`;
      await t(S.Par, L.sprint, "Sprint parent", null);
      await t(S.Child, L.sprint, "Sprint child", S.Par);
      await t(S.Grand, L.sprint, "Sprint grandchild", S.Child);
      await t(S.Out, L.two, "Child outside the sprint", S.Par);
      await sql`INSERT INTO sprint_tasks (sprint_id, task_id) VALUES (${SP}, ${S.Par}), (${SP}, ${S.Child}), (${SP}, ${S.Grand})`;
    });

    it("subtree-count with sprintId counts only subtasks in that sprint", async () => {
      const r = await api("/tasks/subtree-count", { method: "POST", body: { taskIds: [S.Par], sprintId: SP } });
      expect((await r.json()).total).toBe(2);
      const all = await api("/tasks/subtree-count", { method: "POST", body: { taskIds: [S.Par] } });
      expect((await all.json()).total).toBe(3);
    });

    it("remove without the flag takes out only the parent", async () => {
      const r = await api(`/sprints/${SP}/tasks/${S.Par}`, { method: "DELETE" });
      expect(await r.json()).toEqual({ success: true, subtasksUpdated: 0 });
      expect((await task(S.Par)).list_id).toBe(L.one); // the space's Backlog
      expect((await task(S.Child)).list_id).toBe(L.sprint);
      expect(await inSprint(S.Child)).toEqual([SP]);
    });

    it("remove with the flag sends the in-sprint subtree to Backlog and leaves the outside child alone", async () => {
      const r = await api(`/sprints/${SP}/tasks/${S.Par}?applyToSubtasks=true`, { method: "DELETE" });
      expect(await r.json()).toEqual({ success: true, subtasksUpdated: 2 });
      for (const id of [S.Par, S.Child, S.Grand]) {
        expect((await task(id)).list_id).toBe(L.one);
        expect(await inSprint(id)).toEqual([]);
      }
      expect((await task(S.Out)).list_id).toBe(L.two);
      expect((await task(S.Grand)).parent_task_id).toBe(S.Child); // hierarchy intact
    });

    it("move with the flag carries the in-sprint subtree into the next sprint", async () => {
      const r = await api("/sprint-tasks", { method: "PUT", body: { fromSprintId: SP, toSprintId: SP2, taskId: S.Par, applyToSubtasks: true } });
      expect(await r.json()).toEqual({ success: true, subtasksUpdated: 2 });
      for (const id of [S.Par, S.Child, S.Grand]) {
        expect((await task(id)).list_id).toBe(L2);
        expect(await inSprint(id)).toEqual([SP2]);
      }
      expect((await task(S.Out)).list_id).toBe(L.two);
    });

    it("move without the flag moves only the parent", async () => {
      const r = await api("/sprint-tasks", { method: "PUT", body: { fromSprintId: SP, toSprintId: SP2, taskId: S.Par } });
      expect((await r.json()).subtasksUpdated).toBe(0);
      expect((await task(S.Par)).list_id).toBe(L2);
      expect((await task(S.Child)).list_id).toBe(L.sprint);
    });

    it("refuses to touch a task from another workspace through your own sprint", async () => {
      const del = await api(`/sprints/${SP}/tasks/${T.XT}`, { method: "DELETE" });
      expect(del.status).toBe(404);
      const put = await api("/sprint-tasks", { method: "PUT", body: { fromSprintId: SP, toSprintId: SP2, taskId: T.XT } });
      expect(put.status).toBe(404);
      expect((await task(T.XT)).list_id).toBe(L.foreign);
    });

    it("refuses to move a task into another workspace's sprint", async () => {
      const put = await api("/sprint-tasks", { method: "PUT", body: { fromSprintId: SP, toSprintId: SPX, taskId: S.Par } });
      expect(put.status).toBe(403); // not a member of W2
      expect((await task(S.Par)).list_id).toBe(L.sprint);
    });
  });

  describe("any-file uploads, served safely", () => {
    const upload = async (name: string, content: string, type: string) => {
      const form = new FormData();
      form.append("file", new Blob([content], { type }), name);
      const res = await api(`/tasks/${T.U}/attachments`, { method: "POST", form });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const serve = (key: string) => api(`/files/${key}`);

    it.each([
      ["page.html", "<script>alert(1)</script>", "text/html", "text/html; charset=utf-8", "attachment", true],
      ["logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "image/svg+xml", "image/svg+xml", "inline", true],
      ["notes.md", "# Hello", "", "text/plain; charset=utf-8", "inline", true],
      ["spec.pdf", "%PDF-1.4 fake", "application/pdf", "application/pdf", "inline", false],
      ["setup.exe", "MZ fake", "application/x-msdownload", "application/octet-stream", "attachment", true],
      ["résumé final.docx", "PK fake", "", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "attachment", true],
    ])("%s uploads and is served as %s (%s, sandboxed=%s)", async (name, content, type, servedType, disposition, sandboxed) => {
      const up = await upload(name, content, type);
      expect(up.status).toBe(200);
      const res = await serve(up.body.fileKey);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(content);
      expect(res.headers.get("content-type")).toBe(servedType);
      expect(res.headers.get("content-disposition")).toMatch(new RegExp(`^${disposition};`));
      expect(res.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`); // original name kept
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
      const csp = res.headers.get("content-security-policy");
      if (sandboxed) expect(csp).toMatch(/^sandbox;/);
      else expect(csp).toBeNull();
    });
  });
});
