import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";

const { automations, tasks, taskLabels, labels, notifications, taskAssignees } = schema;

export type TriggerType = "status_change" | "task_created" | "due_date_approaching" | "assignment";
export type ActionType = "change_status" | "assign_user" | "add_label" | "send_notification";

export interface AutomationContext {
  taskId: string;
  workspaceId: string;
  userId?: string;
  oldStatus?: string;
  newStatus?: string;
  previousAssignees?: string[];
  newAssignees?: string[];
}

export async function runAutomations(trigger: TriggerType, context: AutomationContext) {
  const matchingAutomations = await db.query.automations.findMany({
    where: and(
      eq(automations.workspaceId, context.workspaceId),
      eq(automations.triggerType, trigger),
      eq(automations.enabled, true)
    ),
  });

  for (const automation of matchingAutomations) {
    try {
      await executeAutomation(automation, context);
    } catch (error) {
      console.error(`Error executing automation ${automation.id}:`, error);
    }
  }
}

async function executeAutomation(automation: typeof automations.$inferSelect, context: AutomationContext) {
  const { actionType, triggerType } = automation;
  const actionConfig = (automation.actionConfig ?? {}) as Record<string, any>;
  const triggerConfig = (automation.triggerConfig ?? {}) as Record<string, any>;

  if (!checkTriggerCondition(triggerType, triggerConfig, context)) return;

  switch (actionType) {
    case "change_status":
      await db.update(tasks).set({ status: actionConfig.status }).where(eq(tasks.id, context.taskId));
      break;
    case "assign_user":
      if (actionConfig.userId) {
        await db.insert(taskAssignees).values({ taskId: context.taskId, userId: actionConfig.userId }).onConflictDoNothing();
      }
      break;
    case "add_label":
      if (actionConfig.labelId) {
        const label = await db.query.labels.findFirst({
          where: and(eq(labels.id, actionConfig.labelId), eq(labels.workspaceId, context.workspaceId)),
        });
        if (label) {
          await db.insert(taskLabels).values({ taskId: context.taskId, labelId: actionConfig.labelId }).onConflictDoNothing();
        }
      }
      break;
    case "send_notification":
      if (actionConfig.userId) {
        await db.insert(notifications).values({
          userId: actionConfig.userId,
          type: "automation",
          title: actionConfig.title || "Automation triggered",
          message: actionConfig.message || `Task was updated by automation: ${context.taskId}`,
          entityType: "task",
          entityId: context.taskId,
        });
      }
      break;
  }
}

function checkTriggerCondition(triggerType: string, triggerConfig: Record<string, any>, context: AutomationContext): boolean {
  switch (triggerType) {
    case "status_change":
      if (!context.oldStatus || !context.newStatus) return false;
      return triggerConfig.fromStatus === context.oldStatus && triggerConfig.toStatus === context.newStatus;
    case "task_created":
      return true;
    case "due_date_approaching":
      return true;
    case "assignment":
      if (!context.previousAssignees || !context.newAssignees) return false;
      return context.newAssignees.filter((a) => !context.previousAssignees?.includes(a)).length > 0;
    default:
      return false;
  }
}

export async function getWorkspaceAutomations(workspaceId: string) {
  return db.query.automations.findMany({
    where: eq(automations.workspaceId, workspaceId),
  });
}

export async function createAutomation(data: {
  workspaceId: string;
  name: string;
  triggerType: TriggerType;
  triggerConfig: Record<string, any>;
  actionType: ActionType;
  actionConfig: Record<string, any>;
  enabled?: boolean;
}) {
  const [automation] = await db.insert(automations).values({
    ...data,
    enabled: data.enabled ?? true,
  }).returning();
  return automation;
}
