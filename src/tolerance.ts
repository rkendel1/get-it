/**
 * Tolerance rules of the frozen contract, as integer comparisons. No division, no floats.
 *
 * "The greater of A absolute or P% of the reference":
 *   |Δ| ≤ max(A, ref × bp / 10 000)  ⇔  10 000·|Δ| ≤ max(10 000·A, |ref|·bp)
 *
 * The reference is always the purchase order's value (the PO is what was agreed). The comparison is
 * inclusive: a variance exactly at the bound is within tolerance.
 */
import type { Tolerances } from "./contract.js";

export interface GreaterOf {
  readonly absolute: number; // same unit as the values compared (micros for unit price, cents for totals)
  readonly basisPoints: number; // 1% = 100 bp
}

export function withinGreaterOf(actual: number, reference: number, rule: GreaterOf): boolean {
  const delta = BigInt(Math.abs(actual - reference));
  const bound = BigInt(Math.max(rule.absolute * 10_000, Math.abs(reference) * rule.basisPoints));
  return delta * 10_000n <= bound;
}

export function unitPriceWithin(billUnitMicros: number, poUnitMicros: number, t: Tolerances): boolean {
  return withinGreaterOf(billUnitMicros, poUnitMicros, { absolute: t.unitPrice.absoluteMicros, basisPoints: t.unitPrice.basisPoints });
}

export function quantityWithin(billQtyMicros: number, poQtyMicros: number, t: Tolerances): boolean {
  if (t.quantity.rule !== "exact") throw new Error(`unsupported quantity rule ${t.quantity.rule}`);
  return billQtyMicros === poQtyMicros;
}

export function totalWithin(billTotalCents: number, expectedTotalCents: number, t: Tolerances): boolean {
  return withinGreaterOf(billTotalCents, expectedTotalCents, { absolute: t.invoiceTotal.absoluteCents, basisPoints: t.invoiceTotal.basisPoints });
}
