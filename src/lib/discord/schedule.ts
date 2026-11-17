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

/**
 * The instant a local wall-clock time refers to in `zone`.
 *
 * Two wall-clock times need a rule, and the rule must not depend on when this
 * code happens to run:
 *  - A time that happens twice (clocks go back) means its FIRST occurrence.
 *    Luxon alone resolves it using the zone's offset at the current moment, so
 *    the same schedule gave the first 01:30 when computed in summer and the
 *    second when computed in winter — and a late scheduler tick after the
 *    change could fire a reminder a second time that night.
 *  - A time that never happens (clocks go forward) moves to the next valid
 *    instant; Luxon does that consistently, so it is left to Luxon.
 * Either way a reminder fires exactly once.
 */
function resolveLocal(
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  zone: string
): DateTime {
  const guess = DateTime.fromObject(wall, { zone });
  if (!guess.isValid) return guess;

  // Every instant that reads as this wall-clock time: try each UTC offset the
  // zone uses around that day and keep the ones that are really in force then.
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const DAY_MS = 86_400_000;
  const offsets = new Set([guess.zone.offset(wallAsUtc - DAY_MS), guess.zone.offset(wallAsUtc + DAY_MS)]);
  let earliest: number | null = null;
  for (const offset of offsets) {
    const ts = wallAsUtc - offset * 60_000;
    if (guess.zone.offset(ts) === offset && (earliest === null || ts < earliest)) earliest = ts;
  }
  return earliest === null ? guess : DateTime.fromMillis(earliest, { zone });
}

function atLocal(date: DateTime, time: string, zone: string): DateTime {
  const [hour, minute] = time.split(":").map(Number);
  return resolveLocal({ year: date.year, month: date.month, day: date.day, hour, minute }, zone);
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
    // `at` is validated as YYYY-MM-DDTHH:mm, a wall-clock time in the zone.
    const [year, month, day, hour, minute] = schedule.at.split(/[-T:]/).map(Number);
    const at = resolveLocal({ year, month, day, hour, minute }, schedule.timezone);
    return at.isValid && at > from ? at.toJSDate() : null;
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
