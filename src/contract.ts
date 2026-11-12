/**
 * Frozen service contracts.
 *
 * - A contract file is the source of truth for its terms.
 * - `contracts/frozen.json` pins each version's digest and its status.
 * - Loading refuses content that no longer matches its pin, so editing a frozen contract fails
 *   instead of silently changing a promise.
 * - A retired version keeps its pin forever. Its id and version can never be reused, and it can never
 *   be loaded again.
 *
 * A change is a new version.
 */
import active from "../contracts/svc_bill_review_payable_prep@1.0.0.json" with { type: "json" };
import frozen from "../contracts/frozen.json" with { type: "json" };
import { digest } from "./canonical.js";

export interface Pricing {
  basePerRunMinor: number;
  includedBills: number;
  perAdditionalBillMinor: number;
}

export type ContractDocument = typeof active;

interface Pin {
  digest: string;
  status: "active" | "retired";
  retiredOn?: string;
  reason?: string;
}

export const PINS = frozen.contracts as Record<string, Pin>;
export const CONTRACT_KEY = `${active.id}@${active.version}` as const;

export function contractDigest(value: unknown = active): string {
  return digest(value);
}

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

/** Verify a contract document against its pin and return its typed terms. */
export function loadFrozenContract(document: ContractDocument = active) {
  const key = `${document.id}@${document.version}`;
  const pin = PINS[key];
  if (!pin) throw new ContractError(`${key} is not frozen`);
  if (pin.status !== "active") throw new ContractError(`${key} is ${pin.status}${pin.reason ? `: ${pin.reason}` : ""}`);
  const actual = contractDigest(document);
  if (actual !== pin.digest) throw new ContractError(`${key} changed after freezing: pinned ${pin.digest}, content ${actual}`);
  const policyDefault = (id: string) => document.inputs.optional.find((i) => i.id === id) as { default: number; min: number; max: number };
  return {
    key,
    digest: pin.digest,
    contract: document,
    statuses: document.statuses as readonly string[],
    exceptionTypes: new Map(document.exceptionTypes.map((e) => [e.type, e])),
    missingInformation: document.missingInformation as Record<string, { ask: string; blocking: boolean }>,
    reviewOverMinor: document.humanReview.reviewOverMinor,
    pricing: document.commercial.pricing as Pricing,
    service: document.service,
    limits: document.inputFormat.limits,
    recommendationValues: document.recommendations.values as readonly string[],
    policyDefaults: {
      documentRequiredOverMinor: policyDefault("policy.documentRequiredOverMinor"),
      dueSoonBusinessDays: policyDefault("policy.dueSoonBusinessDays"),
    },
    deliverableFiles: document.deliverables.flatMap((d) => d.files),
  };
}

export type FrozenContract = ReturnType<typeof loadFrozenContract>;
