import { DateTime } from "luxon";
import { and, asc, count, eq, gte, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { config } from "../../config.js";

const { tasks, taskAssignees, lists, spaces, statuses, workspaceMembers, userDiscordAccounts, workspaceDiscordGuilds } = schema;

// Same convention as the list view and lists API: these statuses are "closed".
export const CLOSED_STATUSES = ["done", "closed", "complete"];
const MAX_LISTED = 15;
const BRAND = 0x6366f1;
export const EPHEMERAL = 1 << 6;

/** Slug a status display name exactly as the list view does ("Not Fixed" → "not_fixed"). */
const STATUS_VALUE_MAP: Record<string, string> = {
  "to do": "todo", todo: "todo", "in progress": "in_progress", in_progress: "in_progress",
  review: "review", "in review": "review", done: "done", closed: "closed",
};
export function statusSlug(name: string): string {
  const n = name.toLowerCase().trim();
  return STATUS_VALUE_MAP[n] || n.replace(/\s+/g, "_");
}
const DEFAULT_STATUS_NAMES: Record<string, string> = { todo: "To Do", in_progress: "In Progress", review: "Review", done: "Done", closed: "Closed" };

const PRIORITY_ICON: Record<string, string> = { urgent: "🔴", high: "🟠", medium: "🟡", low: "🔵" };
const PRIORITY_LABEL: Record<string, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };
const priorityRank = sql`CASE ${tasks.priority} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

export const taskUrl = (workspaceId: string, taskId: string) =>
  `${config.appUrl}/dashboard/workspaces/${workspaceId}/tasks/${taskId}`;
const settingsUrl = () => `${config.appUrl}/dashboard/settings?tab=integrations`;

// Discord renders <t:unix:style> in each viewer's own locale and timezone.
const discordDate = (d: Date) => `<t:${Math.floor(d.getTime() / 1000)}:D>`;
// Stop task titles from breaking markdown/masked links.
const md = (s: string, max = 80) => {
  const t = s.length > max ? `${s.slice(0, max - 1)}…` : s;
  return t.replace(/([\\`*_~|\[\]()<>#@])/g, "\\$1");
};

export const COMMAND_DEFINITIONS = [
  {
    name: "tasks",
    description: "Show your open TaskFlow tasks",
    type: 1,
    contexts: [0], // server channels only: the server decides which workspace
    integration_types: [0],
    options: [
      {
        type: 3, name: "due", description: "Filter by due date", required: false,
        choices: [
          { name: "Overdue", value: "overdue" },
          { name: "Due today", value: "today" },
          { name: "Due in the next 7 days", value: "week" },
          { name: "No due date", value: "none" },
        ],
      },
      { type: 3, name: "status", description: "Filter by status", required: false, autocomplete: true },
      { type: 5, name: "share", description: "Post to the channel instead of only showing you", required: false },
    ],
  },
  {
    name: "task",
    description: "Show a TaskFlow task from its link",
    type: 1,
    contexts: [0],
    integration_types: [0],
    options: [
      { type: 3, name: "link", description: "The task's TaskFlow link (or its ID)", required: true },
      { type: 5, name: "share", description: "Post the card to the channel instead of only showing you", required: false },
    ],
  },
];

// ── Interaction plumbing ─────────────────────────────────────────────────────

export interface Interaction {
  type: number;
  guild_id?: string;
  member?: { user: { id: string } };
  user?: { id: string };
  data?: { name: string; options?: { name: string; value: string | boolean; focused?: boolean }[] };
}
type Reply = { type: number; data: Record<string, unknown> };

const opt = <T>(i: Interaction, name: string) => i.data?.options?.find((o) => o.name === name)?.value as T | undefined;

const message = (data: Record<string, unknown>, share = false): Reply => ({
  type: 4,
  // Replies never ping anyone, even when they render mentions.
  data: { allowed_mentions: { parse: [] }, ...data, flags: share ? 0 : EPHEMERAL },
});
const notice = (content: string, button?: { label: string; url: string }) =>
  message({
    content,
    ...(button && { components: [{ type: 1, components: [{ type: 2, style: 5, label: button.label, url: button.url }] }] }),
  });

type Ctx = { workspaceId: string; userId: string; timezone: string };

/** Map the invoking Discord user + server to a TaskFlow member, or explain what's missing. */
async function resolveContext(i: Interaction): Promise<Ctx | Reply> {
  const discordUserId = i.member?.user.id ?? i.user?.id;
  if (!i.guild_id || !discordUserId) return notice("Use this command inside a Discord server connected to TaskFlow.");

  const guild = await db.query.workspaceDiscordGuilds.findFirst({ where: eq(workspaceDiscordGuilds.guildId, i.guild_id) });
  if (!guild)
    return notice("This server isn't connected to a TaskFlow workspace yet. A workspace admin can connect it from TaskFlow → Settings → Integrations.");

  const account = await db.query.userDiscordAccounts.findFirst({ where: eq(userDiscordAccounts.discordUserId, discordUserId) });
  if (!account)
    return notice("Link your Discord account to TaskFlow first, then run the command again.", { label: "Link Discord account", url: settingsUrl() });

  const member = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, guild.workspaceId), eq(workspaceMembers.userId, account.userId)),
  });
  if (!member) return notice("You're not a member of the TaskFlow workspace connected to this server.");

  return { workspaceId: guild.workspaceId, userId: account.userId, timezone: guild.timezone };
}

async function statusNames(workspaceId: string): Promise<Map<string, string>> {
  const rows = await db.select({ name: statuses.name }).from(statuses).where(eq(statuses.workspaceId, workspaceId)).orderBy(asc(statuses.order));
  const m = new Map(Object.entries(DEFAULT_STATUS_NAMES));
  for (const r of rows) m.set(statusSlug(r.name), r.name);
  return m;
}
const statusLabel = (names: Map<string, string>, slug: string | null) =>
  names.get(slug ?? "todo") ?? (slug ?? "todo").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// ── /tasks ───────────────────────────────────────────────────────────────────

async function handleTasks(i: Interaction, ctx: Ctx): Promise<Reply> {
  const due = opt<string>(i, "due");
  const status = opt<string>(i, "status");
  const share = opt<boolean>(i, "share") ?? false;

  const today = DateTime.now().setZone(ctx.timezone).startOf("day");
  const conds = [
    eq(taskAssignees.userId, ctx.userId),
    eq(spaces.workspaceId, ctx.workspaceId),
    notInArray(tasks.status, CLOSED_STATUSES),
    isNull(tasks.archivedAt),
  ];
  if (status) conds.push(eq(tasks.status, status));
  if (due === "overdue") conds.push(lt(tasks.dueDate, today.toJSDate()));
  if (due === "today") conds.push(gte(tasks.dueDate, today.toJSDate()), lt(tasks.dueDate, today.plus({ days: 1 }).toJSDate()));
  if (due === "week") conds.push(gte(tasks.dueDate, today.toJSDate()), lt(tasks.dueDate, today.plus({ days: 7 }).toJSDate()));
  if (due === "none") conds.push(isNull(tasks.dueDate));
  const where = and(...conds);

  const base = () =>
    db.select().from(tasks)
      .innerJoin(taskAssignees, eq(taskAssignees.taskId, tasks.id))
      .innerJoin(lists, eq(lists.id, tasks.listId))
      .innerJoin(spaces, eq(spaces.id, lists.spaceId))
      .$dynamic();

  const [rows, [{ total }], names] = await Promise.all([
    base().where(where).orderBy(sql`${tasks.dueDate} ASC NULLS LAST`, priorityRank, asc(tasks.createdAt)).limit(MAX_LISTED),
    db.select({ total: count() }).from(tasks)
      .innerJoin(taskAssignees, eq(taskAssignees.taskId, tasks.id))
      .innerJoin(lists, eq(lists.id, tasks.listId))
      .innerJoin(spaces, eq(spaces.id, lists.spaceId))
      .where(where),
    statusNames(ctx.workspaceId),
  ]);

  const filterText = [
    due && { overdue: "overdue", today: "due today", week: "due in the next 7 days", none: "with no due date" }[due],
    status && `in ${statusLabel(names, status)}`,
  ].filter(Boolean).join(", ");

  if (rows.length === 0) return message({ content: `You have no open tasks${filterText ? ` ${filterText}` : ""}. 🎉` }, share);

  const lines = rows.map(({ tasks: t }) => {
    const icon = PRIORITY_ICON[t.priority ?? ""] ?? "⚪";
    const overdue = t.dueDate && t.dueDate.getTime() < today.toMillis() ? " ⚠️" : "";
    const dueText = t.dueDate ? ` · due ${discordDate(t.dueDate)}${overdue}` : "";
    return `${icon} [${md(t.title)}](${taskUrl(ctx.workspaceId, t.id)}) — ${statusLabel(names, t.status)}${dueText}`;
  });

  return message({
    embeds: [{
      title: `Your open tasks${filterText ? ` (${filterText})` : ""}`,
      description: lines.join("\n"),
      color: BRAND,
      footer: { text: total > rows.length ? `Showing ${rows.length} of ${total} — open TaskFlow to see them all` : `${total} task${total === 1 ? "" : "s"}` },
    }],
  }, share);
}

// ── /task ────────────────────────────────────────────────────────────────────

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Accepts …/tasks/<id>, ?task=<id>, or a bare id. A link also contains the workspace id, so position matters. */
export function parseTaskRef(input: string): string | null {
  const s = input.trim();
  const m =
    s.match(new RegExp(`/tasks/(${UUID})`, "i")) ??
    s.match(new RegExp(`[?&]task(?:Id)?=(${UUID})`, "i")) ??
    s.match(new RegExp(`^(${UUID})$`, "i"));
  return m ? m[1].toLowerCase() : null;
}

type TipTapNode = { type?: string; text?: string; content?: TipTapNode[] };
function tiptapText(doc: unknown, max = 300): string {
  const out: string[] = [];
  const walk = (n: TipTapNode) => {
    if (n.text) out.push(n.text);
    n.content?.forEach(walk);
    if (n.type === "paragraph" || n.type === "heading" || n.type === "listItem") out.push("\n");
  };
  if (doc && typeof doc === "object") walk(doc as TipTapNode);
  const text = out.join("").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function handleTask(i: Interaction, ctx: Ctx): Promise<Reply> {
  const share = opt<boolean>(i, "share") ?? false;
  const taskId = parseTaskRef(opt<string>(i, "link") ?? "");
  if (!taskId) return notice("That doesn't look like a TaskFlow task link. Copy it from the task's “Copy link” button.");

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    with: {
      list: { with: { space: true } },
      assignees: { with: { user: { columns: { id: true, name: true, email: true } } } },
    },
  });
  // Same message whether it doesn't exist or belongs to another workspace:
  // don't confirm the existence of tasks the invoker can't see.
  if (!task || task.list?.space?.workspaceId !== ctx.workspaceId)
    return notice("I couldn't find that task in the workspace connected to this server.");

  const userIds = task.assignees.map((a) => a.userId);
  const [linked, names] = await Promise.all([
    userIds.length
      ? db.select().from(userDiscordAccounts).where(inArray(userDiscordAccounts.userId, userIds))
      : Promise.resolve([]),
    statusNames(ctx.workspaceId),
  ]);
  const discordOf = new Map(linked.map((l) => [l.userId, l.discordUserId]));
  const assignees = task.assignees
    .map((a) => (discordOf.has(a.userId) ? `<@${discordOf.get(a.userId)}>` : md(a.user?.name || a.user?.email || "Unknown", 40)))
    .join(", ");

  const url = taskUrl(ctx.workspaceId, task.id);
  const description = tiptapText(task.description);
  return message({
    embeds: [{
      title: task.title.length > 250 ? `${task.title.slice(0, 249)}…` : task.title,
      url,
      description: description || undefined,
      color: BRAND,
      fields: [
        { name: "Status", value: statusLabel(names, task.status), inline: true },
        { name: "Priority", value: `${PRIORITY_ICON[task.priority ?? ""] ?? "⚪"} ${PRIORITY_LABEL[task.priority ?? ""] ?? "None"}`, inline: true },
        { name: "Due", value: task.dueDate ? discordDate(task.dueDate) : "—", inline: true },
        { name: "Assignees", value: assignees || "Unassigned", inline: false },
        { name: "List", value: md(task.list?.name ?? "—", 100), inline: true },
      ],
    }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open in TaskFlow", url }] }],
  }, share);
}

// ── Autocomplete (status) ────────────────────────────────────────────────────

async function handleAutocomplete(i: Interaction): Promise<Reply> {
  const choices: { name: string; value: string }[] = [];
  const focused = i.data?.options?.find((o) => o.focused);
  if (focused?.name === "status" && i.guild_id) {
    const guild = await db.query.workspaceDiscordGuilds.findFirst({ where: eq(workspaceDiscordGuilds.guildId, i.guild_id) });
    if (guild) {
      const q = String(focused.value ?? "").toLowerCase();
      for (const [slug, name] of await statusNames(guild.workspaceId)) {
        if (CLOSED_STATUSES.includes(slug)) continue; // /tasks only lists open tasks
        if (!q || name.toLowerCase().includes(q)) choices.push({ name, value: slug });
      }
    }
  }
  return { type: 8, data: { choices: choices.slice(0, 25) } };
}

/** Route one verified interaction to its handler. */
export async function handleInteraction(i: Interaction): Promise<Reply | { type: 1 }> {
  if (i.type === 1) return { type: 1 }; // PING → PONG
  if (i.type === 4) return handleAutocomplete(i);
  if (i.type !== 2) return notice("That interaction isn't supported.");

  const ctx = await resolveContext(i);
  if ("type" in ctx) return ctx;

  switch (i.data?.name) {
    case "tasks": return handleTasks(i, ctx);
    case "task": return handleTask(i, ctx);
    default: return notice("Unknown command.");
  }
}
