import { db, schema } from "../db/index.js";
import { and, eq, inArray } from "drizzle-orm";
import { sendTaskAssignedEmail, sendMentionEmail, sendTaskDueSoonEmail } from "./email.js";
import { sendToUser } from "../plugins/sse.js";

const { notifications, users, workspaceMembers, tasks, lists, spaces } = schema;

export type NotificationType =
  | "task_assigned"
  | "task_completed"
  | "comment_added"
  | "mention"
  | "sprint_started"
  | "sprint_ended"
  | "sprint_completed"
  | "task_due_soon"
  | "automation";

interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  message?: string;
  entityType?: string;
  entityId?: string;
  taskTitle?: string;
  mentionedBy?: string;
  assignedBy?: string;
  dueDate?: Date;
  workspaceId?: string;
  spaceId?: string;
  listId?: string;
}

async function shouldSendEmail(userId: string): Promise<boolean> {
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { emailNotifications: true, email: true },
    });
    return user?.emailNotifications !== false && !!user?.email;
  } catch {
    return false;
  }
}

export async function isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
  const row = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
    columns: { userId: true },
  });
  return !!row;
}

/** The workspace a task lives in, or undefined if the task is gone. */
async function workspaceOfTask(taskId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ workspaceId: spaces.workspaceId })
    .from(tasks)
    .innerJoin(lists, eq(tasks.listId, lists.id))
    .innerJoin(spaces, eq(lists.spaceId, spaces.id))
    .where(eq(tasks.id, taskId))
    .limit(1);
  return row?.workspaceId;
}

/**
 * Create a notification (bell row + email + live push) for one user.
 *
 * The single gate for workspace isolation: a notification that comes from a
 * workspace is only created if the recipient is a member of it RIGHT NOW.
 * Callers pick recipients from data that can be stale (a task's creator or
 * assignee who has since been removed, a reminder set months ago) or
 * user-supplied (mentions, automation config), so the check lives here rather
 * than at each call site. Returns null when the recipient is skipped.
 */
export async function createNotification(params: CreateNotificationParams) {
  let workspaceId = params.workspaceId;
  if (!workspaceId && params.entityType === "task" && params.entityId) {
    workspaceId = await workspaceOfTask(params.entityId);
  }
  if (workspaceId && !(await isWorkspaceMember(workspaceId, params.userId))) return null;

  const truncatedTitle = params.title.length > 255 ? params.title.slice(0, 252) + "..." : params.title;
  const [notification] = await db.insert(notifications).values({
    userId: params.userId,
    type: params.type,
    title: truncatedTitle,
    message: params.message || null,
    entityType: params.entityType || null,
    entityId: params.entityId || null,
  }).returning();

  const sendEmail = async () => {
    const shouldEmail = await shouldSendEmail(params.userId);
    if (!shouldEmail) return;

    const user = await db.query.users.findFirst({
      where: eq(users.id, params.userId),
      columns: { email: true, name: true },
    });
    if (!user?.email) return;

    try {
      switch (params.type) {
        case "task_assigned":
          if (params.taskTitle && params.assignedBy) {
            await sendTaskAssignedEmail(user.email, params.taskTitle, params.assignedBy);
          }
          break;
        case "mention":
          if (params.taskTitle && params.mentionedBy) {
            await sendMentionEmail(user.email, params.taskTitle, params.mentionedBy);
          }
          break;
        case "task_due_soon":
          if (params.taskTitle && params.dueDate) {
            await sendTaskDueSoonEmail(user.email, params.taskTitle, params.dueDate);
          }
          break;
      }
    } catch (error) {
      console.error("[Notifications] Failed to send email:", error);
    }
  };

  sendEmail();

  const notificationData = {
    id: notification.id,
    title: notification.title,
    message: notification.message,
    type: notification.type,
    userId: notification.userId,
    entityType: params.entityType || null,
    entityId: params.entityId || null,
    spaceId: params.spaceId || null,
    listId: params.listId || null,
  };
  const sseEvent = { type: "notification" as const, data: notificationData };

  if (workspaceId) {
    sendToUser(workspaceId, params.userId, sseEvent);
  } else {
    try {
      const memberships = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, params.userId));
      for (const m of memberships) {
        sendToUser(m.workspaceId, params.userId, sseEvent);
      }
    } catch {
      // Non-critical
    }
  }

  return notification;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Plain-text "@name" tokens (legacy / API clients that send plain text). */
export function parseMentions(content: string): string[] {
  const mentionRegex = /@(\w+)/g;
  const mentions: string[] = [];
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    const username = match[1].toLowerCase();
    if (!mentions.includes(username)) {
      mentions.push(username);
    }
  }
  return mentions;
}

/**
 * What a comment mentions. The editor saves TipTap JSON in which a mention is
 * a node carrying the user's id; plain text falls back to "@name" tokens.
 */
export function extractMentions(content: string): { userIds: string[]; names: string[] } {
  const userIds = new Set<string>();
  const texts: string[] = [];
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { parsed = undefined; }

  if (parsed && typeof parsed === "object") {
    const walk = (node: unknown, depth: number) => {
      if (!node || typeof node !== "object" || depth > 50) return;
      if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
      const n = node as { type?: unknown; text?: unknown; attrs?: { id?: unknown }; content?: unknown };
      if (n.type === "mention" && typeof n.attrs?.id === "string" && UUID.test(n.attrs.id)) userIds.add(n.attrs.id.toLowerCase());
      if (n.type === "text" && typeof n.text === "string") texts.push(n.text);
      walk(n.content, depth + 1);
    };
    walk(parsed, 0);
  } else {
    texts.push(content);
  }
  return { userIds: [...userIds], names: parseMentions(texts.join(" ")) };
}

/**
 * The users a comment mentions, limited to members of the given workspace.
 * Never looks outside it: an id or a name that belongs to someone in another
 * workspace resolves to nobody.
 */
export async function resolveMentionedMembers(content: string, workspaceId: string): Promise<string[]> {
  const { userIds, names } = extractMentions(content);
  if (userIds.length === 0 && names.length === 0) return [];

  const found = new Set<string>();
  if (userIds.length > 0) {
    const rows = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, userIds)));
    for (const r of rows) found.add(r.userId);
  }
  if (names.length > 0) {
    const members = await db
      .select({ id: users.id, name: users.name })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, workspaceId));
    for (const m of members) {
      if (m.name && names.includes(m.name.toLowerCase())) found.add(m.id);
    }
  }
  return [...found];
}

/**
 * Notify the workspace members mentioned in `content`. Pass `mentionedUserIds`
 * when they were already resolved with resolveMentionedMembers.
 */
export async function notifyMentions(
  content: string,
  mentionedByUserId: string,
  entityType: string,
  entityId: string,
  taskTitle: string | undefined,
  workspaceId: string,
  spaceId?: string,
  listId?: string,
  mentionedUserIds?: string[],
) {
  const targets = (mentionedUserIds ?? (await resolveMentionedMembers(content, workspaceId)))
    .filter((id) => id !== mentionedByUserId);
  if (targets.length === 0) return [];

  const mentioner = await db.query.users.findFirst({
    where: eq(users.id, mentionedByUserId),
    columns: { name: true },
  });
  const mentionedByName = mentioner?.name || "Someone";

  const createdNotifications = [];
  for (const userId of targets) {
    const notification = await createNotification({
      userId,
      type: "mention",
      title: `You were mentioned by ${mentionedByName}`,
      message: taskTitle ? `${mentionedByName} mentioned you on "${taskTitle}"` : `You were mentioned in a ${entityType}`,
      entityType,
      entityId,
      taskTitle,
      mentionedBy: mentionedByName,
      workspaceId,
      spaceId,
      listId,
    });
    if (notification) createdNotifications.push(notification);
  }

  return createdNotifications;
}
