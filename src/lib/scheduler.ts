import { and, asc, eq, inArray, lt, lte } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { isDiscordConfigured } from "./discord/api.js";
import { deliverReminder } from "./discord/deliver.js";
import { nextOccurrence, scheduleSchema } from "./discord/schedule.js";
import { notifyTaskReminder } from "./reminders.js";
import type { DiscordReminder } from "../db/schema/index.js";

const { discordReminders, reminders } = schema;

// Overridable so the e2e suite doesn't wait 30s per tick.
export const TICK_MS = Number(process.env.SCHEDULER_TICK_MS) || 30_000;
/** Occurrences more than this late (e.g. the server was down) are skipped, not sent. */
export const GRACE_MS = 15 * 60_000;
const BATCH = 25;

type Log = { info: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

/**
 * Discord reminders due now.
 *
 * At-most-once: each due row is claimed (FOR UPDATE SKIP LOCKED) and its next
 * run committed BEFORE the message is sent. Two overlapping ticks — or two
 * containers during a rolling deploy — can never both send the same
 * occurrence; the worst case on a crash mid-send is one missed reminder,
 * recorded as failed, rather than a double ping.
 */
export async function runDiscordReminders(now = new Date(), log?: Log): Promise<{ sent: number; skipped: number; failed: number }> {
  const result = { sent: 0, skipped: 0, failed: 0 };
  if (!isDiscordConfigured()) return result;

  const toSend = await db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(discordReminders)
      .where(and(eq(discordReminders.enabled, true), lte(discordReminders.nextRunAt, now)))
      .orderBy(asc(discordReminders.nextRunAt))
      .limit(BATCH)
      .for("update", { skipLocked: true });

    const claimed: DiscordReminder[] = [];
    for (const r of due) {
      const parsed = scheduleSchema.safeParse(r.schedule);
      if (!parsed.success) {
        await tx.update(discordReminders)
          .set({ enabled: false, nextRunAt: null, lastStatus: "failed", lastError: "Invalid schedule — edit and save the reminder to fix it", lastRunAt: now })
          .where(eq(discordReminders.id, r.id));
        result.failed++;
        continue;
      }
      // Next occurrence strictly after NOW (not after the due time), so a
      // long outage resumes on schedule instead of replaying every miss.
      // A one-time reminder is done once it has fired (or been skipped),
      // whatever its stored due time says — it must never fire twice.
      const next = parsed.data.kind === "once" ? null : nextOccurrence(parsed.data, now);
      const lateMs = now.getTime() - r.nextRunAt!.getTime();
      const late = lateMs > GRACE_MS;
      await tx.update(discordReminders)
        .set({
          nextRunAt: next,
          enabled: next !== null,
          ...(late && { lastStatus: "skipped", lastRunAt: now, lastError: `Skipped: ${Math.round(lateMs / 60_000)} min late (server was unavailable)` }),
        })
        .where(eq(discordReminders.id, r.id));
      if (late) result.skipped++;
      else claimed.push(r);
    }
    return claimed;
  });

  for (const r of toSend) {
    try {
      await deliverReminder(r);
      await db.update(discordReminders).set({ lastStatus: "sent", lastError: null, lastRunAt: now }).where(eq(discordReminders.id, r.id));
      result.sent++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await db.update(discordReminders).set({ lastStatus: "failed", lastError: msg.slice(0, 500), lastRunAt: now }).where(eq(discordReminders.id, r.id));
      log?.error({ reminderId: r.id, err: msg }, "discord reminder delivery failed");
      result.failed++;
    }
  }
  return result;
}

/**
 * Existing per-task in-app reminders. Nothing used to trigger these. Anything
 * already more than GRACE_MS overdue is marked sent WITHOUT notifying, so the
 * first run after deploy doesn't flood users with stale reminders — and the
 * same rule covers later downtime. Claimed atomically, like the above.
 */
export async function runTaskReminders(now = new Date(), log?: Log): Promise<{ sent: number; skipped: number }> {
  const skipped = await db.update(reminders)
    .set({ sent: true })
    .where(and(eq(reminders.sent, false), lt(reminders.remindAt, new Date(now.getTime() - GRACE_MS))))
    .returning({ id: reminders.id });

  const claimedIds = await db.transaction(async (tx) => {
    const due = await tx.select({ id: reminders.id }).from(reminders)
      .where(and(eq(reminders.sent, false), lte(reminders.remindAt, now)))
      .orderBy(asc(reminders.remindAt))
      .limit(100)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    const ids = due.map((d) => d.id);
    await tx.update(reminders).set({ sent: true }).where(inArray(reminders.id, ids));
    return ids;
  });

  let sent = 0;
  for (const id of claimedIds) {
    try {
      await notifyTaskReminder(id);
      sent++;
    } catch (error) {
      log?.error({ reminderId: id, err: error instanceof Error ? error.message : String(error) }, "task reminder notification failed");
    }
  }
  return { sent, skipped: skipped.length };
}

/** Start the in-process scheduler. Returns a stop function for graceful shutdown. */
export function startScheduler(log: Log): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // a slow tick never overlaps the next one
    running = true;
    try {
      const d = await runDiscordReminders(new Date(), log);
      const t = await runTaskReminders(new Date(), log);
      if (d.sent || d.skipped || d.failed || t.sent || t.skipped) log.info({ discord: d, task: t }, "scheduler tick");
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, "scheduler tick failed");
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, Math.min(5_000, TICK_MS));
  const interval = setInterval(tick, TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}
