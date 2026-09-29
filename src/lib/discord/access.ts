import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";

const { workspaceMembers } = schema;
export const MANAGE_CONNECTION_ROLES = ["owner", "admin"];
// Viewers can see reminders but not change them.
export const MANAGE_REMINDER_ROLES = ["owner", "admin", "member"];

export async function membership(workspaceId: string, userId: string) {
  return db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
}
