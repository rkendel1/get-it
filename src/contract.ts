/**
 * The frozen service contract. The JSON file is the source of truth; `contracts/frozen.json` pins
 * its digest. Loading refuses a contract whose content no longer matches its pin, so an edit to a
 * frozen contract is a failure, not a silent change. A change is a new version.
 */
import contract from "../contracts/svc_invoice_reconciliation@1.0.0.json" with { type: "json" };
import frozen from "../contracts/frozen.json" with { type: "json" };
import { digest } from "./canonical.js";

export interface Tolerances {
  unitPrice: { rule: "greater_of"; absoluteMicros: number; basisPoints: number };
  quantity: { rule: "exact" };
  invoiceTotal: { rule: "greater_of"; absoluteCents: number; basisPoints: number };
}

export interface Pricing {
  basePerRunCents: number;
  includedInvoices: number;
  perAdditionalInvoiceCents: number;
}

export type ServiceContract = typeof contract;
export const CONTRACT_KEY = `${contract.id}@${contract.version}` as const;

export function contractDigest(value: unknown = contract): string {
  return digest(value);
}

export function loadFrozenContract() {
  const pinned = (frozen as Record<string, string>)[CONTRACT_KEY];
  if (!pinned) throw new Error(`${CONTRACT_KEY} is not frozen`);
  const actual = contractDigest();
  if (actual !== pinned) throw new Error(`${CONTRACT_KEY} changed after freezing: pinned ${pinned}, content ${actual}`);
  return {
    key: CONTRACT_KEY,
    digest: pinned,
    contract,
    tolerances: contract.tolerances as unknown as Tolerances,
    pricing: contract.commercial.pricing as Pricing,
    reviewOverCents: contract.review.humanReviewRequiredOverCents,
    reviewForeignCurrency: contract.review.reviewRequiredWhenForeignCurrency,
    service: contract.service,
    customerDecisionTypes: new Set(contract.exceptionTypes.filter((e) => e.decision === "customer").map((e) => e.type)),
  };
}

export type FrozenContract = ReturnType<typeof loadFrozenContract>;
