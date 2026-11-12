/**
 * Exact amounts. No floating-point arithmetic touches money.
 *
 * - Amounts are integer **cents**. A source amount with more than 2 decimals is refused.
 * - Unit prices are integer **micros** (1e-6 of the currency unit), because QuickBooks unit prices
 *   may carry more than two decimals. More than 6 decimals is refused.
 * - Quantities are integer **micros** of a unit (6 decimals).
 *
 * Source numbers arrive as JSON numbers or strings. They are parsed from their decimal text, never
 * multiplied as floats. All products go through BigInt; rounding is half away from zero, applied
 * once.
 */

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

/** Parse a decimal (number or string) into an integer count of 10^-scale units. */
export function parseScaled(value: unknown, scale: number, what: string): number {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AmountError(`${what}: not a finite number`);
    // JSON numbers from the source: their shortest round-trip decimal text is what was sent.
    text = numberToPlainString(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    throw new AmountError(`${what}: expected a number, got ${value === null ? "null" : typeof value}`);
  }
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new AmountError(`${what}: "${text}" is not a decimal number`);
  const [, sign, whole, frac = ""] = m;
  const trimmed = frac.replace(/0+$/, "");
  if (trimmed.length > scale) throw new AmountError(`${what}: "${text}" has more than ${scale} decimal places`);
  const units = BigInt(whole!) * 10n ** BigInt(scale) + BigInt((trimmed + "0".repeat(scale)).slice(0, scale) || "0");
  const signed = sign ? -units : units;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < -BigInt(Number.MAX_SAFE_INTEGER)) throw new AmountError(`${what}: out of range`);
  return Number(signed);
}

function numberToPlainString(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  // Exponent form (very large or very small): expand exactly from the digits.
  const [mantissa, expText] = s.toLowerCase().split("e") as [string, string];
  const exp = Number(expText);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "");
  const [intPart, fracPart = ""] = digits.split(".") as [string, string?];
  const all = intPart + fracPart;
  const point = intPart.length + exp;
  const body = point <= 0 ? `0.${"0".repeat(-point)}${all}` : point >= all.length ? all + "0".repeat(point - all.length) : `${all.slice(0, point)}.${all.slice(point)}`;
  return (negative ? "-" : "") + body;
}

export const cents = (value: unknown, what = "amount") => parseScaled(value, 2, what);
export const micros = (value: unknown, what = "value") => parseScaled(value, 6, what);

/** Round a BigInt ratio half away from zero. */
function roundDiv(n: bigint, d: bigint): bigint {
  const negative = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an + ad / 2n) / ad;
  return negative ? -q : q;
}

/** quantity (micros) × unit price (micros) → cents. 1e-6 × 1e-6 = 1e-12; cents are 1e-2, so ÷ 1e10. */
export function extendCents(quantityMicros: number, unitPriceMicros: number): number {
  return Number(roundDiv(BigInt(quantityMicros) * BigInt(unitPriceMicros), 10_000_000_000n));
}

/** |a − b| for safe integers. */
export const absDiff = (a: number, b: number) => Math.abs(a - b);

export function formatCents(c: number): string {
  const sign = c < 0 ? "-" : "";
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

export function formatMicros(m: number): string {
  const sign = m < 0 ? "-" : "";
  const a = Math.abs(m);
  const frac = String(a % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return `${sign}${Math.floor(a / 1_000_000)}${frac ? `.${frac}` : ""}`;
}
