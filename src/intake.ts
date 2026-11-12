/**
 * Intake rules, derived from the frozen contract and nowhere else.
 *
 * - An input whose contract `source` is the customer bill set (bills, vendors, accounts, prior bills)
 *   is bound by uploading the bill set. Every other input is answered.
 * - Each answer is validated against its contract `kind` and, for integers, the contract's `min` and
 *   `max`. A kind this module does not know is a contract error, never a silent pass.
 * - Required inputs block completion. An optional input that is declined, not answered, or not
 *   supplied becomes an explicit assumption, and its contract default applies when it has one.
 *
 * The completeness report is a pure function of (contract, answers, addressed bill set). It holds no
 * times or actors, so the same inputs always give the same report and digest.
 */
import { isCalendarDate } from "./bills.js";
import { assertTimeZone } from "./calendar.js";
import { ContractError, type FrozenContract } from "./contract.js";
import type { AddressedBillSet } from "./snapshot.js";

export interface InputSpec {
  readonly id: string;
  readonly kind: string;
  readonly required: boolean;
  readonly source: "answer" | "bill set";
  readonly default?: unknown;
  readonly min?: number;
  readonly max?: number;
  readonly note?: string;
}

const BILL_SET_SOURCE = "customer bill set";

/** The contract's inputs: required before optional; within each, answered before bill-set; then contract order. */
export function inputSpecs(contract: FrozenContract): InputSpec[] {
  const specs: InputSpec[] = [];
  for (const [required, list] of [[true, contract.contract.inputs.required], [false, contract.contract.inputs.optional]] as const) {
    const of = (bill: boolean) =>
      (list as ReadonlyArray<Record<string, unknown>>)
        .filter((i) => (i.source === BILL_SET_SOURCE) === bill)
        .map((i) => ({
          id: i.id as string,
          kind: i.kind as string,
          required,
          source: bill ? ("bill set" as const) : ("answer" as const),
          ...(i.default !== undefined ? { default: i.default } : {}),
          ...(typeof i.min === "number" ? { min: i.min } : {}),
          ...(typeof i.max === "number" ? { max: i.max } : {}),
          ...(typeof i.note === "string" ? { note: i.note } : {}),
        }));
    specs.push(...of(false), ...of(true));
  }
  return specs;
}

export type AnswerValidation = { ok: true; value: string | number } | { ok: false; issue: string };

/** Validate one answer against its contract input. */
export function validateAnswer(spec: InputSpec, value: unknown): AnswerValidation {
  switch (spec.kind) {
    case "iso-4217":
      return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? { ok: true, value } : { ok: false, issue: `${spec.id} must be an ISO 4217 currency code such as USD` };
    case "iana-time-zone":
      if (typeof value !== "string" || value.length === 0) return { ok: false, issue: `${spec.id} must be an IANA time zone such as America/New_York` };
      try {
        assertTimeZone(value);
        return { ok: true, value };
      } catch {
        return { ok: false, issue: `${spec.id}: unknown time zone ${value}` };
      }
    case "iso-date":
      return isCalendarDate(value) ? { ok: true, value } : { ok: false, issue: `${spec.id} must be a calendar date (YYYY-MM-DD)` };
    case "integer": {
      const min = spec.min ?? Number.MIN_SAFE_INTEGER;
      const max = spec.max ?? Number.MAX_SAFE_INTEGER;
      return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? { ok: true, value } : { ok: false, issue: `${spec.id} must be an integer between ${min} and ${max}` };
    }
    default:
      throw new ContractError(`the contract declares input ${spec.id} of kind ${spec.kind}, which intake cannot validate`);
  }
}

export type AnswerState = { kind: "answer"; value: unknown } | { kind: "decline" };

export interface Assumption {
  readonly input: string;
  readonly how: "declined" | "not_answered" | "not_supplied";
  readonly statement: string;
}

export interface ReviewBindings {
  readonly homeCurrency: string;
  readonly timeZone: string;
  readonly asOfDate: string;
  readonly policy: { readonly documentRequiredOverMinor: number; readonly dueSoonBusinessDays: number };
}

export interface CompletenessReport {
  readonly contract: string;
  readonly contractDigest: string;
  readonly inputs: ReadonlyArray<{ readonly id: string; readonly required: boolean; readonly source: "answer" | "bill set"; readonly status: "bound" | "assumed" | "missing"; readonly value?: string | number }>;
  readonly billSet: { readonly digest: string; readonly bills: number; readonly vendors: number; readonly accounts: number; readonly priorBills: number } | null;
  readonly assumptions: readonly Assumption[];
}

export interface Completeness {
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly assumptions: readonly Assumption[];
  readonly report: CompletenessReport;
  /** The review scope the answers bind (defaults applied); meaningful only when complete. */
  readonly bindings: ReviewBindings;
}

const billSetCount = (set: AddressedBillSet, id: string) => (set.counts as Record<string, number>)[id] ?? 0;

export function completeness(contract: FrozenContract, answers: ReadonlyMap<string, AnswerState>, billSet: AddressedBillSet | null): Completeness {
  const missing: string[] = [];
  const assumptions: Assumption[] = [];
  const inputs: Array<CompletenessReport["inputs"][number]> = [];
  const values: Record<string, unknown> = {};

  for (const spec of inputSpecs(contract)) {
    if (spec.source === "bill set") {
      // The upload binds every bill-set input at once; prior bills may legitimately be absent.
      const bound = billSet !== null && (spec.required || billSetCount(billSet, spec.id) > 0);
      if (bound) inputs.push({ id: spec.id, required: spec.required, source: spec.source, status: "bound" });
      else if (spec.required) {
        missing.push(spec.id);
        inputs.push({ id: spec.id, required: true, source: spec.source, status: "missing" });
      } else {
        assumptions.push({ input: spec.id, how: "not_supplied", statement: `${spec.id} was not supplied${spec.note ? ` (${spec.note})` : ""}: the review proceeds without it.` });
        inputs.push({ id: spec.id, required: false, source: spec.source, status: "assumed" });
      }
      continue;
    }
    const a = answers.get(spec.id);
    if (a?.kind === "answer") {
      const v = validateAnswer(spec, a.value);
      if (!v.ok) throw new ContractError(`stored answer for ${spec.id} is invalid: ${v.issue}`);
      values[spec.id] = v.value;
      inputs.push({ id: spec.id, required: spec.required, source: spec.source, status: "bound", value: v.value });
    } else if (spec.required) {
      missing.push(spec.id);
      inputs.push({ id: spec.id, required: true, source: spec.source, status: "missing" });
    } else {
      const how = a?.kind === "decline" ? "declined" : "not_answered";
      const consequence = spec.default !== undefined ? `the contract default ${String(spec.default)} applies` : "the review proceeds without it";
      assumptions.push({ input: spec.id, how, statement: `${spec.id} was ${how === "declined" ? "declined" : "not answered"}: ${consequence}.` });
      if (spec.default !== undefined) values[spec.id] = spec.default;
      inputs.push({ id: spec.id, required: false, source: spec.source, status: "assumed" });
    }
  }

  const report: CompletenessReport = {
    contract: contract.key,
    contractDigest: contract.digest,
    inputs,
    billSet: billSet ? { digest: billSet.digest, ...billSet.counts } : null,
    assumptions,
  };
  const bindings: ReviewBindings = {
    homeCurrency: values.homeCurrency as string,
    timeZone: values.timeZone as string,
    asOfDate: values.asOfDate as string,
    policy: { documentRequiredOverMinor: values["policy.documentRequiredOverMinor"] as number, dueSoonBusinessDays: values["policy.dueSoonBusinessDays"] as number },
  };
  return { complete: missing.length === 0, missing, assumptions, report, bindings };
}
