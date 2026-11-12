/**
 * Money as integer minor units (cents for USD), as Ledger stores it. No floating-point value ever
 * represents money.
 *
 * Bill-set amounts arrive as JSON integers (`amountMinor`, `taxMinor`, `totalMinor`). Anything else
 * (a decimal, a string, NaN, an unsafe integer) is not an amount. Sums are exact, and are refused
 * rather than rounded when they leave the safe-integer range.
 */

/** Whether a value is a minor-unit amount within [min, Number.MAX_SAFE_INTEGER]. */
export function isMinor(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

/** Exact sum of minor-unit amounts. Throws if the total is not a safe integer. */
export function sumMinor(values: readonly number[]): number {
  let total = 0n;
  for (const v of values) total += BigInt(v);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < -BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("sum out of the safe-integer range");
  return Number(total);
}

/** Display form for exports: 123456 → "1234.56" (two decimals; the integer is always exported beside it). */
export function formatMinor(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const a = Math.abs(minor);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}
