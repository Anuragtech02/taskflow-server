import { db, schema } from "../db/index.js";
import { eq, or } from "drizzle-orm";
import { sendTaskAssignedEmail, sendMentionEmail, sendTaskDueSoonEmail } from "./email.js";
import { broadcastToWorkspace } from "../plugins/sse.js";

const { notifications, users, workspaceMembers } = schema;

export type NotificationType =
  | "task_assigned"
  | "task_completed"
  | "comment_added"
  | "mention"
  | "sprint_started"
  | "sprint_ended"
  | "sprint_completed"
  | "task_due_soon";

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

export async function createNotification(params: CreateNotificationParams) {
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

  if (params.workspaceId) {
    broadcastToWorkspace(params.workspaceId, {
      type: "notification",
      data: {
        id: notification.id,
        title: notification.title,
        message: notification.message,
        type: notification.type,
        userId: notification.userId,
      },
    });
  } else {
    try {
      const memberships = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, params.userId));
      for (const m of memberships) {
        broadcastToWorkspace(m.workspaceId, {
          type: "notification",
          data: {
            id: notification.id,
            title: notification.title,
            message: notification.message,
            type: notification.type,
            userId: notification.userId,
          },
        });
      }
    } catch {
      // Non-critical
    }
  }

  return notification;
}

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

export async function getUsersByUsernames(usernames: string[]) {
  if (usernames.length === 0) return [];
  const conditions = usernames.map((username) => eq(users.name, username));
  const foundUsers = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(or(...conditions));
  return foundUsers;
}

export async function notifyMentions(
  content: string,
  mentionedByUserId: string,
  entityType: string,
  entityId: string,
  taskTitle?: string,
  workspaceId?: string
) {
  const usernames = parseMentions(content);
  if (usernames.length === 0) return [];

  const mentionedUsers = await getUsersByUsernames(usernames);

  const mentioner = await db.query.users.findFirst({
    where: eq(users.id, mentionedByUserId),
    columns: { name: true },
  });
  const mentionedByName = mentioner?.name || "Someone";

  const createdNotifications = [];
  for (const user of mentionedUsers) {
    if (user.id === mentionedByUserId) continue;
    const notification = await createNotification({
      userId: user.id,
      type: "mention",
      title: `You were mentioned by ${mentionedByName}`,
      message: `You were mentioned in a ${entityType}`,
      entityType,
      entityId,
      taskTitle,
      mentionedBy: mentionedByName,
      workspaceId,
    });
    createdNotifications.push(notification);
  }

  return createdNotifications;
}
