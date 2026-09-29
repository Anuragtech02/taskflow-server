import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { discordApi } from "./api.js";
import { taskUrl } from "./commands.js";
import type { DiscordReminder } from "../../db/schema/index.js";

const { userDiscordAccounts, tasks } = schema;
const CONTENT_LIMIT = 2000; // Discord's hard cap on message content

/**
 * Build the channel message for a reminder. TaskFlow users are mapped to
 * Discord mentions here, at send time — members who link their account after
 * the reminder was created get tagged without anyone editing it. Unlinked
 * members can't be mentioned and are reported back so the dashboard can say so.
 */
export async function buildReminderMessage(r: Pick<DiscordReminder, "workspaceId" | "message" | "taskId" | "mentionUserIds" | "mentionRoleIds" | "mentionHere">, opts: { test?: boolean } = {}) {
  const linked = r.mentionUserIds.length
    ? await db.select().from(userDiscordAccounts).where(inArray(userDiscordAccounts.userId, r.mentionUserIds))
    : [];
  const discordUserIds = linked.map((l) => l.discordUserId);
  const unlinkedUserIds = r.mentionUserIds.filter((id) => !linked.some((l) => l.userId === id));

  const mentions = [
    ...(r.mentionHere ? ["@here"] : []),
    ...r.mentionRoleIds.map((id) => `<@&${id}>`),
    ...discordUserIds.map((id) => `<@${id}>`),
  ].join(" ");

  const prefix = opts.test ? "🔔 **Test reminder** — " : "🔔 ";
  let content = [mentions, `${prefix}${r.message}`].filter(Boolean).join("\n");
  if (content.length > CONTENT_LIMIT) content = `${content.slice(0, CONTENT_LIMIT - 1)}…`;

  let embeds: unknown[] | undefined;
  if (r.taskId) {
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, r.taskId), columns: { id: true, title: true, dueDate: true } });
    if (task) {
      embeds = [{
        title: task.title.slice(0, 250),
        url: taskUrl(r.workspaceId, task.id),
        color: 0x6366f1,
        ...(task.dueDate && { description: `Due <t:${Math.floor(task.dueDate.getTime() / 1000)}:D>` }),
      }];
    }
  }

  return {
    body: {
      content,
      ...(embeds && { embeds }),
      // Only ping exactly who the reminder names — never whatever text a
      // message happens to contain.
      allowed_mentions: { users: discordUserIds, roles: r.mentionRoleIds, parse: r.mentionHere ? ["everyone"] : [] },
    },
    unlinkedUserIds,
  };
}

export async function deliverReminder(r: DiscordReminder, opts: { test?: boolean } = {}) {
  const { body, unlinkedUserIds } = await buildReminderMessage(r, opts);
  const sent = await discordApi.sendMessage(r.channelId, body);
  return { messageId: sent.id, unlinkedUserIds };
}
