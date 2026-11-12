/**
 * Price and charge, as the frozen contract states them. Integer cents throughout.
 */
import type { Pricing } from "./contract.js";

/** The price of a run over `invoices` counted invoices. */
export function runPriceCents(invoices: number, p: Pricing): number {
  if (!Number.isInteger(invoices) || invoices < 0) throw new RangeError("invoice count must be a non-negative integer");
  return p.basePerRunCents + Math.max(0, invoices - p.includedInvoices) * p.perAdditionalInvoiceCents;
}

export type ChargeOutcome =
  | { kind: "delivered"; invoicesCounted: number }
  | { kind: "platform_failure" }
  | { kind: "partial"; customerAcceptedPortion: boolean; invoicesAccepted: number }
  | { kind: "cancelled"; customerAcceptedPortion: boolean; invoicesAccepted: number };

export interface Charge {
  readonly cents: number;
  readonly basis: string;
}

export function charge(outcome: ChargeOutcome, p: Pricing): Charge {
  switch (outcome.kind) {
    case "platform_failure":
      return { cents: 0, basis: "platform failure: not charged" };
    case "delivered":
      return { cents: runPriceCents(outcome.invoicesCounted, p), basis: `delivered: ${outcome.invoicesCounted} invoices` };
    case "partial":
    case "cancelled":
      if (!outcome.customerAcceptedPortion || outcome.invoicesAccepted === 0) return { cents: 0, basis: `${outcome.kind}: no completed portion accepted, not charged` };
      return { cents: runPriceCents(outcome.invoicesAccepted, p), basis: `${outcome.kind}: customer accepted ${outcome.invoicesAccepted} invoices` };
  }
}
