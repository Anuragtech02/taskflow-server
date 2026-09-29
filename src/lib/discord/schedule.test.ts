import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { nextOccurrence, scheduleSchema, type Schedule } from "./schedule.js";

const S = (s: unknown) => scheduleSchema.parse(s) as Schedule;
const utc = (iso: string) => new Date(iso);
const local = (d: Date | null, zone: string) =>
  d ? DateTime.fromJSDate(d).setZone(zone).toFormat("yyyy-MM-dd HH:mm ccc") : null;

describe("once", () => {
  const s = S({ kind: "once", at: "2026-10-01T09:00", timezone: "Asia/Kolkata" });
  it("fires at the local wall-clock time in its zone", () => {
    expect(nextOccurrence(s, utc("2026-09-30T00:00Z"))?.toISOString()).toBe("2026-10-01T03:30:00.000Z");
  });
  it("has no occurrence once past", () => {
    expect(nextOccurrence(s, utc("2026-10-01T03:30Z"))).toBeNull(); // strictly after
    expect(nextOccurrence(s, utc("2026-10-02T00:00Z"))).toBeNull();
  });
});

describe("daily, multiple times a day", () => {
  const s = S({ kind: "daily", times: ["18:00", "09:00", "13:00", "09:00"], timezone: "Asia/Kolkata" });
  it("dedupes and sorts times", () => {
    expect((s as { times: string[] }).times).toEqual(["09:00", "13:00", "18:00"]);
  });
  it("picks the next time later the same day", () => {
    expect(local(nextOccurrence(s, utc("2026-10-01T04:30Z")), "Asia/Kolkata")).toBe("2026-10-01 13:00 Thu"); // 10:00 IST
  });
  it("is strictly after: exactly at 13:00 moves to 18:00", () => {
    expect(local(nextOccurrence(s, utc("2026-10-01T07:30Z")), "Asia/Kolkata")).toBe("2026-10-01 18:00 Thu");
  });
  it("rolls to the next day after the last time", () => {
    expect(local(nextOccurrence(s, utc("2026-10-01T13:00Z")), "Asia/Kolkata")).toBe("2026-10-02 09:00 Fri"); // 18:30 IST
  });
});

describe("weekly on chosen days", () => {
  const s = S({ kind: "weekly", days: [4, 1], times: ["10:00"], timezone: "Europe/Amsterdam" });
  it("from a Tuesday, next is Thursday", () => {
    expect(local(nextOccurrence(s, utc("2026-09-29T12:00Z")), "Europe/Amsterdam")).toBe("2026-10-01 10:00 Thu");
  });
  it("after Thursday's run, next is Monday", () => {
    expect(local(nextOccurrence(s, utc("2026-10-01T08:00Z")), "Europe/Amsterdam")).toBe("2026-10-05 10:00 Mon");
  });
  it("a long run of occurrences only lands on chosen days at the chosen time, strictly increasing", () => {
    let t = utc("2026-09-01T00:00Z");
    for (let i = 0; i < 60; i++) {
      const n = nextOccurrence(s, t)!;
      expect(n.getTime()).toBeGreaterThan(t.getTime());
      const l = DateTime.fromJSDate(n).setZone("Europe/Amsterdam");
      expect([1, 4]).toContain(l.weekday);
      expect(l.toFormat("HH:mm")).toBe("10:00"); // holds across the Oct DST change
      t = n;
    }
  });
});

describe("every N days", () => {
  const s = S({ kind: "interval", everyDays: 3, startDate: "2026-09-28", times: ["09:00"], timezone: "UTC" });
  it("before the start date, first run is the start date", () => {
    expect(local(nextOccurrence(s, utc("2026-09-01T00:00Z")), "UTC")).toBe("2026-09-28 09:00 Mon");
  });
  it("keeps a 3-day cadence across a month boundary", () => {
    const a = nextOccurrence(s, utc("2026-09-28T09:00Z"));
    const b = nextOccurrence(s, a!);
    expect(local(a, "UTC")).toBe("2026-10-01 09:00 Thu");
    expect(local(b, "UTC")).toBe("2026-10-04 09:00 Sun");
  });
});

describe("daylight saving (America/New_York, 2027)", () => {
  const zone = "America/New_York";
  it("keeps 09:00 local across spring-forward (UTC offset changes, local time does not)", () => {
    const s = S({ kind: "daily", times: ["09:00"], timezone: zone });
    expect(nextOccurrence(s, utc("2027-03-13T00:00Z"))?.toISOString()).toBe("2027-03-13T14:00:00.000Z"); // EST
    expect(nextOccurrence(s, utc("2027-03-14T00:00Z"))?.toISOString()).toBe("2027-03-14T13:00:00.000Z"); // EDT
  });
  it("a time skipped by spring-forward (02:30) fires once, at the next valid instant", () => {
    const s = S({ kind: "daily", times: ["02:30"], timezone: zone });
    const n = nextOccurrence(s, utc("2027-03-14T05:00Z"))!; // 00:00 EST
    expect(local(n, zone)).toBe("2027-03-14 03:30 Sun");
    expect(local(nextOccurrence(s, n), zone)).toBe("2027-03-15 02:30 Mon"); // no second fire that day
  });
  it("a time that happens twice at fall-back (01:30) fires once", () => {
    const s = S({ kind: "daily", times: ["01:30"], timezone: zone });
    const n = nextOccurrence(s, utc("2027-11-07T04:00Z"))!; // 00:00 EDT
    expect(n.toISOString()).toBe("2027-11-07T05:30:00.000Z"); // the first 01:30 (EDT)
    expect(local(nextOccurrence(s, n), zone)).toBe("2027-11-08 01:30 Mon"); // not the repeated 01:30 EST
  });
});

describe("validation", () => {
  const ok = { kind: "daily", times: ["09:00"], timezone: "UTC" };
  it.each([
    ["bad time", { ...ok, times: ["25:00"] }],
    ["no times", { ...ok, times: [] }],
    ["unknown timezone", { ...ok, timezone: "Mars/Olympus" }],
    ["weekly without days", { kind: "weekly", days: [], times: ["09:00"], timezone: "UTC" }],
    ["weekday out of range", { kind: "weekly", days: [0], times: ["09:00"], timezone: "UTC" }],
    ["interval of 0 days", { kind: "interval", everyDays: 0, startDate: "2026-01-01", times: ["09:00"], timezone: "UTC" }],
    ["unknown kind", { kind: "hourly", timezone: "UTC" }],
  ])("rejects %s", (_name, input) => {
    expect(scheduleSchema.safeParse(input).success).toBe(false);
  });
});
