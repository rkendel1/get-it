/**
 * Business days: Monday–Friday excluding US federal holidays (observed), in the customer's time zone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { correctionWindowEnd, endOfLocalDay, isBusinessDay, localDate, turnaroundDeadline, usFederalHolidays } from "../src/calendar.js";

const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);

test("US federal holidays, observed, 2026 and 2027", () => {
  assert.deepEqual([...usFederalHolidays(2026)].sort(), [
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19",
    "2026-07-03", // July 4 is a Saturday: observed Friday
    "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25",
  ]);
  assert.deepEqual([...usFederalHolidays(2027)].sort(), [
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31",
    "2027-06-18", // June 19 is a Saturday
    "2027-07-05", // July 4 is a Sunday: observed Monday
    "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25",
    "2027-12-24", // December 25 is a Saturday
    "2027-12-31", // January 1, 2028 is a Saturday: observed in 2027
  ]);
  assert.ok(!isBusinessDay("2026-11-26"));
  assert.ok(!isBusinessDay("2026-11-28"));
  assert.ok(isBusinessDay("2026-11-27"));
});

test("two business days, skipping Thanksgiving, ending 23:59:59.999 in the customer's zone", () => {
  // Wednesday 2026-11-25 10:00 New York. Thu 26 is a holiday; Fri 27 is day 1, Mon 30 is day 2.
  const d = turnaroundDeadline({ start: at("2026-11-25T15:00:00Z"), timeZone: NY, businessDays: 2, blockedLimitBusinessDays: 10, now: at("2026-11-25T15:00:00Z") });
  assert.equal(d.deadlineDate, "2026-11-30");
  assert.equal(d.deadline, at("2026-12-01T04:59:59.999Z")); // EST, UTC−5
  assert.equal(d.paused, false);
});

test("the customer's time zone decides the start date", () => {
  const instant = at("2026-11-13T03:00:00Z"); // Thursday 22:00 in New York, Friday 12:00 in Tokyo
  assert.equal(localDate(instant, NY), "2026-11-12");
  assert.equal(localDate(instant, "Asia/Tokyo"), "2026-11-13");
  const ny = turnaroundDeadline({ start: instant, timeZone: NY, businessDays: 2, blockedLimitBusinessDays: 10, now: instant });
  const tokyo = turnaroundDeadline({ start: instant, timeZone: "Asia/Tokyo", businessDays: 2, blockedLimitBusinessDays: 10, now: instant });
  assert.equal(ny.deadlineDate, "2026-11-16"); // Fri 13, Mon 16
  assert.equal(tokyo.deadlineDate, "2026-11-17"); // Mon 16, Tue 17
  assert.equal(tokyo.deadline, at("2026-11-17T14:59:59.999Z")); // JST, UTC+9
});

test("daylight saving: end of day uses the offset in force that day", () => {
  assert.equal(endOfLocalDay("2026-10-30", NY), at("2026-10-31T03:59:59.999Z")); // EDT, UTC−4
  assert.equal(endOfLocalDay("2026-11-02", NY), at("2026-11-03T04:59:59.999Z")); // EST, UTC−5
});

test("customer-blocked business days pause the clock and do not count", () => {
  const start = at("2026-11-25T15:00:00Z");
  // Blocked Friday 27 10:00–14:00: that day does not count; Mon 30 day 1, Tue Dec 1 day 2.
  const blocked = [{ from: at("2026-11-27T15:00:00Z"), to: at("2026-11-27T19:00:00Z") }];
  const d = turnaroundDeadline({ start, timeZone: NY, businessDays: 2, blocked, blockedLimitBusinessDays: 10, now: at("2026-11-28T12:00:00Z") });
  assert.equal(d.deadlineDate, "2026-12-01");
  assert.equal(d.blockedBusinessDays, 1);
  // While a block is open there is no deadline.
  const open = turnaroundDeadline({ start, timeZone: NY, businessDays: 2, blocked: [{ from: at("2026-11-27T15:00:00Z"), to: null }], blockedLimitBusinessDays: 10, now: at("2026-11-30T15:00:00Z") });
  assert.deepEqual([open.paused, open.deadline, open.blockedBusinessDays], [true, null, 2]); // Fri 27 and Mon 30
});

test("ten blocked business days reach the cancel-or-re-quote limit", () => {
  const from = at("2026-12-01T15:00:00Z"); // Tue Dec 1
  const nine = turnaroundDeadline({ start: from, timeZone: NY, businessDays: 2, blocked: [{ from, to: null }], blockedLimitBusinessDays: 10, now: at("2026-12-11T15:00:00Z") });
  assert.deepEqual([nine.blockedBusinessDays, nine.blockedLimitReached], [9, false]); // Dec 1–4, 7–11
  const ten = turnaroundDeadline({ start: from, timeZone: NY, businessDays: 2, blocked: [{ from, to: null }], blockedLimitBusinessDays: 10, now: at("2026-12-14T15:00:00Z") });
  assert.deepEqual([ten.blockedBusinessDays, ten.blockedLimitReached], [10, true]);
});

test("the correction window is five business days after the delivery's local date", () => {
  // Delivered Monday 2026-12-21 New York: Tue 22, Wed 23, Thu 24, (Fri 25 holiday), Mon 28, Tue 29.
  assert.equal(correctionWindowEnd(at("2026-12-21T20:00:00Z"), NY, 5), at("2026-12-30T04:59:59.999Z"));
});
