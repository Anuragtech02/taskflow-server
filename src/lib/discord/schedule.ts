import { DateTime, IANAZone } from "luxon";
import { z } from "zod";

/**
 * Reminder schedules.
 *
 * Stored as structured JSON rather than an RFC 5545 RRULE string: the kinds we
 * support are few, the dashboard edits them field-by-field, and rrule's
 * timezone handling returns "floating" dates that are easy to misread. Every
 * occurrence is computed in the schedule's own IANA timezone with Luxon, so a
 * 09:00 reminder stays at 09:00 local time across daylight-saving changes.
 *
 * Weekdays use ISO numbering: 1 = Monday … 7 = Sunday.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24h HH:mm");
const timezone = z.string().refine((tz) => IANAZone.isValidZone(tz), "Unknown timezone");
// Several times a day, deduped + sorted so evaluation order is stable.
const times = z
  .array(hhmm)
  .min(1, "Add at least one time")
  .max(24)
  .transform((t) => [...new Set(t)].sort());

export const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("once"),
    // Local wall-clock date-time in `timezone`, e.g. "2026-10-01T09:00".
    at: z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, "Use YYYY-MM-DDTHH:mm"),
    timezone,
  }),
  z.object({ kind: z.literal("daily"), times, timezone }),
  z.object({
    kind: z.literal("weekly"),
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1, "Pick at least one day")
      .transform((d) => [...new Set(d)].sort()),
    times,
    timezone,
  }),
  z.object({
    kind: z.literal("interval"),
    everyDays: z.number().int().min(1).max(365),
    // Anchor day for the every-N-days cycle.
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
    times,
    timezone,
  }),
]);

export type Schedule = z.infer<typeof scheduleSchema>;

function atLocal(date: DateTime, time: string, zone: string): DateTime {
  const [hour, minute] = time.split(":").map(Number);
  // A wall-clock time skipped by a spring-forward DST jump is moved forward by
  // Luxon to the next valid instant; an ambiguous fall-back time resolves to
  // the first occurrence. Either way the reminder fires exactly once.
  return DateTime.fromObject(
    { year: date.year, month: date.month, day: date.day, hour, minute },
    { zone }
  );
}

function dayMatches(s: Exclude<Schedule, { kind: "once" }>, day: DateTime): boolean {
  switch (s.kind) {
    case "daily":
      return true;
    case "weekly":
      return s.days.includes(day.weekday);
    case "interval": {
      const start = DateTime.fromISO(s.startDate, { zone: s.timezone }).startOf("day");
      const diff = Math.round(day.startOf("day").diff(start, "days").days);
      return diff >= 0 && diff % s.everyDays === 0;
    }
  }
}

/**
 * The first occurrence strictly after `after`, or null when the schedule has
 * no future occurrence (a one-time reminder already past).
 */
export function nextOccurrence(schedule: Schedule, after: Date): Date | null {
  const from = DateTime.fromJSDate(after);

  if (schedule.kind === "once") {
    const at = DateTime.fromISO(schedule.at, { zone: schedule.timezone });
    return at > from ? at.toJSDate() : null;
  }

  // Walk local calendar days in the schedule's zone. The horizon covers the
  // longest interval (365 days) plus slack; every recurring kind is
  // guaranteed to hit within it.
  let day = from.setZone(schedule.timezone).startOf("day");
  for (let i = 0; i < 400; i++, day = day.plus({ days: 1 })) {
    if (!dayMatches(schedule, day)) continue;
    for (const t of schedule.times) {
      const candidate = atLocal(day, t, schedule.timezone);
      if (candidate > from) return candidate.toJSDate();
    }
  }
  return null;
}

/** Human summary for the dashboard and message footers. */
export function describeSchedule(s: Schedule): string {
  const DAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const at = "times" in s ? s.times.join(", ") : "";
  switch (s.kind) {
    case "once":
      return `Once on ${s.at.replace("T", " at ")} (${s.timezone})`;
    case "daily":
      return `Daily at ${at} (${s.timezone})`;
    case "weekly":
      return `Every ${s.days.map((d) => DAY[d]).join(", ")} at ${at} (${s.timezone})`;
    case "interval":
      return `Every ${s.everyDays} day${s.everyDays === 1 ? "" : "s"} from ${s.startDate} at ${at} (${s.timezone})`;
  }
}
