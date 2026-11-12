/**
 * Business days, as the frozen contract defines them: Monday to Friday, excluding US federal holidays
 * (5 U.S.C. 6103, observed dates), in the customer's IANA time zone.
 *
 * Observed dates: a holiday on a Saturday is observed the Friday before; on a Sunday, the Monday
 * after. January 1 on a Saturday is therefore observed on December 31 of the previous year, and
 * that date counts as a holiday of the previous year.
 *
 * Dates are ISO `YYYY-MM-DD` strings. Instants are epoch milliseconds. No library: the time-zone
 * conversion uses `Intl.DateTimeFormat`, which ships with Node's full ICU.
 */

const DAY_MS = 86_400_000;

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseIso(date: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`not an ISO date: ${date}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  const { y, m, d } = parseIso(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const { y, m, d } = parseIso(date);
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** The nth (1-based) given weekday of a month; n = -1 is the last. */
function nthWeekday(y: number, month: number, dow: number, n: number): string {
  if (n > 0) {
    const first = weekday(iso(y, month, 1));
    return iso(y, month, 1 + ((dow - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(y, month, 0)).getUTCDate();
  const last = weekday(iso(y, month, lastDay));
  return iso(y, month, lastDay - ((last - dow + 7) % 7));
}

function observed(date: string): string {
  const w = weekday(date);
  return w === 6 ? addDays(date, -1) : w === 0 ? addDays(date, 1) : date;
}

const holidayCache = new Map<number, Set<string>>();

/** Observed US federal holiday dates falling in `year`. */
export function usFederalHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const actual = (y: number) => [
    iso(y, 1, 1), // New Year's Day
    nthWeekday(y, 1, 1, 3), // Birthday of Martin Luther King, Jr.: third Monday of January
    nthWeekday(y, 2, 1, 3), // Washington's Birthday: third Monday of February
    nthWeekday(y, 5, 1, -1), // Memorial Day: last Monday of May
    iso(y, 6, 19), // Juneteenth National Independence Day
    iso(y, 7, 4), // Independence Day
    nthWeekday(y, 9, 1, 1), // Labor Day: first Monday of September
    nthWeekday(y, 10, 1, 2), // Columbus Day: second Monday of October
    iso(y, 11, 11), // Veterans Day
    nthWeekday(y, 11, 4, 4), // Thanksgiving Day: fourth Thursday of November
    iso(y, 12, 25), // Christmas Day
  ];
  const dates = new Set<string>();
  // The next year's New Year's Day can be observed on December 31 of this year.
  for (const d of [...actual(year), iso(year + 1, 1, 1)].map(observed)) if (d.startsWith(`${year}-`)) dates.add(d);
  holidayCache.set(year, dates);
  return dates;
}

export function isBusinessDay(date: string): boolean {
  const w = weekday(date);
  if (w === 0 || w === 6) return false;
  return !usFederalHolidays(parseIso(date).y).has(date);
}

// ---- time zones --------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(timeZone, f);
  }
  return f;
}

export function assertTimeZone(timeZone: string): void {
  try {
    formatter(timeZone);
  } catch {
    throw new RangeError(`unknown time zone: ${timeZone}`);
  }
}

function parts(instant: number, timeZone: string) {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

/** The customer's calendar date at an instant. */
export function localDate(instant: number, timeZone: string): string {
  const p = parts(instant, timeZone);
  return iso(p.y, p.m, p.d);
}

/** The instant of a local wall-clock time (the earlier one when a DST change repeats it). */
function localToInstant(date: string, h: number, mi: number, s: number, ms: number, timeZone: string): number {
  const { y, m, d } = parseIso(date);
  const wall = Date.UTC(y, m - 1, d, h, mi, s, ms);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = parts(guess, timeZone);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s, ms);
    const next = guess - (asUtc - wall);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** 23:59:59.999 on `date` in the customer's time zone. */
export function endOfLocalDay(date: string, timeZone: string): number {
  return localToInstant(date, 23, 59, 59, 999, timeZone);
}

// ---- contract clocks ---------------------------------------------------------------------------

/** The `n`th business day strictly after `date`, skipping any date in `skip`. */
export function nthBusinessDayAfter(date: string, n: number, skip: ReadonlySet<string> = new Set()): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("n must be a positive integer");
  let d = date;
  let counted = 0;
  while (counted < n) {
    d = addDays(d, 1);
    if (isBusinessDay(d) && !skip.has(d)) counted++;
  }
  return d;
}

export interface BlockedInterval {
  readonly from: number; // instant the customer-blocked state began
  readonly to: number | null; // instant it ended; null while still blocked
}

/** Every business date (local) touched by a blocked interval, up to `now` for an open one. */
export function blockedBusinessDates(blocked: readonly BlockedInterval[], timeZone: string, now: number): Set<string> {
  const dates = new Set<string>();
  for (const b of blocked) {
    const end = localDate(b.to ?? now, timeZone);
    for (let d = localDate(b.from, timeZone); d <= end; d = addDays(d, 1)) if (isBusinessDay(d)) dates.add(d);
  }
  return dates;
}

export interface Deadline {
  /** The deadline instant, or null while the clock is paused by an open customer block. */
  readonly deadline: number | null;
  readonly deadlineDate: string | null;
  readonly paused: boolean;
  /** Business days the customer has kept the order blocked (cumulative). */
  readonly blockedBusinessDays: number;
  /** The contract's limit is reached: the order must be cancelled or re-quoted. */
  readonly blockedLimitReached: boolean;
}

/**
 * Turnaround deadline: the end of the `businessDays`th counted business day after the local date
 * the clock started. A business day on which the customer blocked the order at any time does not
 * count. While a block is open the clock is paused and there is no deadline.
 */
export function turnaroundDeadline(input: {
  start: number;
  timeZone: string;
  businessDays: number;
  blocked?: readonly BlockedInterval[];
  blockedLimitBusinessDays: number;
  now: number;
}): Deadline {
  const blocked = input.blocked ?? [];
  const dates = blockedBusinessDates(blocked, input.timeZone, input.now);
  const paused = blocked.some((b) => b.to === null);
  const blockedLimitReached = dates.size >= input.blockedLimitBusinessDays;
  if (paused) return { deadline: null, deadlineDate: null, paused, blockedBusinessDays: dates.size, blockedLimitReached };
  const deadlineDate = nthBusinessDayAfter(localDate(input.start, input.timeZone), input.businessDays, dates);
  return { deadline: endOfLocalDay(deadlineDate, input.timeZone), deadlineDate, paused, blockedBusinessDays: dates.size, blockedLimitReached };
}

/** The end of the correction window: `businessDays` business days after the delivery's local date. */
export function correctionWindowEnd(delivered: number, timeZone: string, businessDays: number): number {
  return endOfLocalDay(nthBusinessDayAfter(localDate(delivered, timeZone), businessDays), timeZone);
}
