/**
 * Price and charge, as the frozen contract states them. Integer minor units throughout.
 */
import type { Pricing } from "./contract.js";

/** The price of a run over `bills` counted bills. */
export function runPriceMinor(bills: number, p: Pricing): number {
  if (!Number.isInteger(bills) || bills < 0) throw new RangeError("bill count must be a non-negative integer");
  return p.basePerRunMinor + Math.max(0, bills - p.includedBills) * p.perAdditionalBillMinor;
}

export type ChargeOutcome =
  | { kind: "accepted"; billsCounted: number }
  | { kind: "partial"; customerAcceptedPortion: boolean; billsAccepted: number }
  | { kind: "cancelled"; customerAcceptedPortion: boolean; billsAccepted: number }
  | { kind: "platform_failure" }
  | { kind: "failed_acceptance" };

export interface Charge {
  readonly minor: number;
  readonly basis: string;
}

export function charge(outcome: ChargeOutcome, p: Pricing): Charge {
  switch (outcome.kind) {
    case "platform_failure":
      return { minor: 0, basis: "platform failure: not charged" };
    case "failed_acceptance":
      return { minor: 0, basis: "failed an acceptance criterion: not charged" };
    case "accepted":
      return { minor: runPriceMinor(outcome.billsCounted, p), basis: `accepted: ${outcome.billsCounted} bills` };
    case "partial":
    case "cancelled":
      if (!outcome.customerAcceptedPortion || outcome.billsAccepted === 0) return { minor: 0, basis: `${outcome.kind}: no completed portion accepted, not charged` };
      return { minor: runPriceMinor(outcome.billsAccepted, p), basis: `${outcome.kind}: customer accepted ${outcome.billsAccepted} bills` };
  }
}
