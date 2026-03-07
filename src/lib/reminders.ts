import { db, schema } from "../db/index.js";
import { eq, and, lte } from "drizzle-orm";
import { createNotification } from "./notifications.js";

const { reminders } = schema;

export async function checkAndSendReminders(): Promise<number> {
  const now = new Date();
  const pendingReminders = await db.query.reminders.findMany({
    where: and(eq(reminders.sent, false), lte(reminders.remindAt, now)),
    with: {
      task: { with: { list: { with: { space: true } } } },
      user: { columns: { id: true, name: true, email: true } },
    },
  });

  if (pendingReminders.length === 0) return 0;

  let sentCount = 0;
  for (const reminder of pendingReminders) {
    try {
      const taskTitle = reminder.task?.title || "Untitled Task";
      const dueDateStr = reminder.task?.dueDate
        ? new Date(reminder.task.dueDate).toLocaleDateString()
        : "No due date";

      await createNotification({
        userId: reminder.userId,
        type: "task_due_soon",
        title: `Reminder: ${taskTitle}`,
        message: `Task "${taskTitle}" is due on ${dueDateStr}`,
        entityType: "task",
        entityId: reminder.taskId,
        taskTitle,
        dueDate: reminder.task?.dueDate ? new Date(reminder.task.dueDate) : undefined,
        workspaceId: reminder.task?.list?.space?.workspaceId,
      });

      await db.update(reminders).set({ sent: true }).where(eq(reminders.id, reminder.id));
      sentCount++;
    } catch (error) {
      console.error(`Error processing reminder ${reminder.id}:`, error);
    }
  }
  return sentCount;
}

export async function autoCreateDueDateReminder(taskId: string, userId: string, dueDate: Date): Promise<void> {
  const oneDayBefore = new Date(dueDate.getTime() - 24 * 60 * 60 * 1000);
  if (oneDayBefore <= new Date()) return;

  const existingReminder = await db.query.reminders.findFirst({
    where: and(eq(reminders.taskId, taskId), eq(reminders.userId, userId), eq(reminders.sent, false)),
  });
  if (existingReminder) return;

  await db.insert(reminders).values({ taskId, userId, remindAt: oneDayBefore, type: "notification" });
}

export async function createReminder(taskId: string, userId: string, remindAt: Date, type: "notification" | "email" | "both" = "notification") {
  const [reminder] = await db.insert(reminders).values({ taskId, userId, remindAt, type }).returning();
  return reminder;
}

export async function deleteReminder(reminderId: string) {
  await db.delete(reminders).where(eq(reminders.id, reminderId));
}

export async function getTaskReminders(taskId: string) {
  return db.query.reminders.findMany({ where: eq(reminders.taskId, taskId) });
}

export async function getUserPendingReminders(userId: string) {
  return db.query.reminders.findMany({
    where: and(eq(reminders.userId, userId), eq(reminders.sent, false), lte(reminders.remindAt, new Date())),
    with: { task: true },
  });
}
