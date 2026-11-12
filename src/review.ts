/**
 * Bill review and payable preparation, exactly as `svc_bill_review_payable_prep@1.0.0` states it.
 *
 * Deterministic: the same snapshot and contract always give the same output, byte for byte. There
 * is no model, no clock (the review date is the order's `asOfDate`), no randomness and no I/O.
 *
 * For every bill the engine runs a fixed list of checks and records each outcome as evidence. Every
 * failed check raises one exception of a contract type. The bill's status is the first status, in
 * contract order, among its exceptions. Recommendations are advisory: nothing here, or anywhere in
 * get-it, approves, posts, pays or voids a bill.
 */
import { addDays, nthBusinessDayAfter } from "./calendar.js";
import { digest } from "./canonical.js";
import { validateBill, type Bill, type BillValidation, type PriorBill, type Vendor } from "./bills.js";
import type { FrozenContract } from "./contract.js";
import { sumMinor } from "./money.js";
import { setOf, type ManifestEntry, type Snapshot } from "./snapshot.js";

export const CHECKS = [
  "schema",
  "vendor_known",
  "accounts_known",
  "duplicate_in_set",
  "duplicate_of_prior",
  "near_duplicate",
  "subtotal",
  "tax",
  "total",
  "currency_home",
  "vendor_active",
  "accounts_active",
  "terms",
  "not_future_dated",
  "awaiting_approval",
  "document",
] as const;
export type CheckId = (typeof CHECKS)[number];

/** The exception type a failed check raises. */
const RAISES: Record<CheckId, string> = {
  schema: "malformed_bill",
  vendor_known: "vendor_unknown",
  accounts_known: "account_unknown",
  duplicate_in_set: "duplicate_in_set",
  duplicate_of_prior: "duplicate_of_prior",
  near_duplicate: "near_duplicate",
  subtotal: "subtotal_mismatch",
  tax: "tax_mismatch",
  total: "total_mismatch",
  currency_home: "foreign_currency",
  vendor_active: "vendor_inactive",
  accounts_active: "account_inactive",
  terms: "terms_mismatch",
  not_future_dated: "future_dated",
  awaiting_approval: "not_awaiting_approval",
  document: "document_missing",
};
export const exceptionTypeOf = (check: CheckId) => RAISES[check];

const DUPLICATE_TYPES = new Set(["duplicate_in_set", "duplicate_of_prior", "near_duplicate"]);

export interface Check {
  readonly id: CheckId;
  readonly outcome: "pass" | "fail" | "not_applicable";
  readonly detail: string | null;
}

export interface BillResult {
  readonly billKey: string;
  readonly vendorId: string | null;
  readonly billNumber: string | null;
  readonly billDate: string | null;
  readonly dueDate: string | null;
  readonly currency: string | null;
  readonly totalMinor: number | null;
  readonly status: string;
  readonly checks: readonly Check[];
  readonly exceptionIds: readonly string[];
  readonly requestIds: readonly string[];
  readonly source: ManifestEntry;
  /** The reference records the bill was checked against (vendor, accounts, matching prior bills). */
  readonly references: readonly ManifestEntry[];
}

export interface BillException {
  readonly id: string;
  readonly billKey: string;
  readonly type: string;
  readonly status: string;
  readonly decision: "operator" | "customer";
  readonly requiresReview: boolean;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly detail: string;
  readonly sources: readonly ManifestEntry[];
}

export interface InformationRequest {
  readonly id: string;
  readonly billKey: string;
  readonly exceptionId: string;
  readonly ask: string;
  readonly detail: string;
  readonly blocking: boolean;
  readonly sources: readonly ManifestEntry[];
}

export interface Recommendation {
  readonly billKey: string;
  readonly recommendation: "approve_for_payment" | "hold" | "reject_resubmit";
  readonly advisory: true;
  readonly vendorId: string | null;
  readonly billNumber: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly payBy: string | null;
  readonly priority: "overdue" | "due_soon" | "scheduled" | null;
  readonly reasons: readonly string[];
  readonly sources: readonly ManifestEntry[];
}

export interface SourceDocumentReference {
  readonly billKey: string;
  readonly ref: string;
  readonly kind: string;
  readonly sha256: string | null;
  readonly sources: readonly ManifestEntry[];
}

export interface ReviewOutput {
  readonly contract: string;
  readonly contractDigest: string;
  readonly snapshotDigest: string;
  readonly asOfDate: string;
  readonly homeCurrency: string;
  readonly results: readonly BillResult[];
  readonly exceptions: readonly BillException[];
  readonly requests: readonly InformationRequest[];
  readonly recommendations: readonly Recommendation[];
  readonly documents: readonly SourceDocumentReference[];
  readonly summary: {
    readonly bills: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly exceptions: number;
    readonly requiringReview: number;
    readonly customerDecisions: number;
    readonly blockingRequests: number;
    /** Sum of totals recommended for payment approval, per currency (never converted). */
    readonly recommendedForApprovalMinor: Readonly<Record<string, number>>;
  };
}

const normNumber = (n: string) => n.trim().toLowerCase();
const byKey = <T extends { billKey: string }>(a: T, b: T) => (a.billKey < b.billKey ? -1 : a.billKey > b.billKey ? 1 : 0);
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function review(snapshot: Snapshot, contract: FrozenContract): ReviewOutput {
  const set = setOf(snapshot, contract);
  const { homeCurrency, asOfDate, policy } = snapshot.scope;
  const entry = new Map(snapshot.manifest.map((m) => [`${m.kind}:${m.key}`, m]));
  const ref = (kind: ManifestEntry["kind"], key: string) => entry.get(`${kind}:${key}`)!;
  const priorEntries = snapshot.manifest.filter((m) => m.kind === "priorBill");
  const priorByKey = new Map(snapshot.records.filter((r) => r.kind === "priorBill").map((r) => [r.key, r.record as PriorBill]));

  const keyed = snapshot.records.filter((r) => r.kind === "bill").map((r) => ({ key: r.key, v: validateBill(r.record, contract.limits.maxLinesPerBill) }));
  const valid = keyed.filter((k): k is { key: string; v: Extract<BillValidation, { ok: true }> } => k.v.ok);

  // Duplicate indexes over the valid bills of the set.
  const byNumber = new Map<string, string[]>();
  for (const { key, v } of valid) {
    const k = `${v.bill.vendorId}|${normNumber(v.bill.billNumber)}`;
    byNumber.set(k, [...(byNumber.get(k) ?? []), key]);
  }

  const results: BillResult[] = [];
  const exceptions: BillException[] = [];
  const requests: InformationRequest[] = [];
  const recommendations: Recommendation[] = [];
  const documents: SourceDocumentReference[] = [];
  const statusRank = new Map(contract.statuses.map((s, i) => [s, i]));

  for (const { key, v } of keyed) {
    const source = ref("bill", key);
    const bill: Bill | null = v.ok ? v.bill : null;
    const checks: Check[] = [];
    const references: ManifestEntry[] = [];
    const check = (id: CheckId, outcome: Check["outcome"], detail: string | null = null) => checks.push({ id, outcome, detail });

    if (!bill) {
      check("schema", "fail", (v as { issues: string[] }).issues.join("; "));
      for (const id of CHECKS.slice(1)) check(id, "not_applicable");
    } else {
      check("schema", "pass");
      const vendor: Vendor | undefined = set.vendors.get(bill.vendorId);
      if (vendor) references.push(ref("vendor", vendor.id));
      check("vendor_known", vendor ? "pass" : "fail", vendor ? null : `vendor ${bill.vendorId} is not in the vendor list`);
      const accountIds = [...new Set(bill.lines.map((l) => l.accountId))].sort();
      const unknownAccounts = accountIds.filter((a) => !set.accounts.has(a));
      for (const a of accountIds) if (set.accounts.has(a)) references.push(ref("account", a));
      check("accounts_known", unknownAccounts.length ? "fail" : "pass", unknownAccounts.length ? `unknown account(s): ${unknownAccounts.join(", ")}` : null);

      const sameNumber = (byNumber.get(`${bill.vendorId}|${normNumber(bill.billNumber)}`) ?? []).filter((k) => k !== key);
      check("duplicate_in_set", sameNumber.length ? "fail" : "pass", sameNumber.length ? `same vendor and bill number as ${sameNumber.sort().join(", ")}` : null);

      const priorMatches = priorEntries.filter((p) => {
        const prior = priorByKey.get(p.key)!;
        return prior.vendorId === bill.vendorId && normNumber(prior.billNumber) === normNumber(bill.billNumber);
      });
      references.push(...priorMatches);
      check("duplicate_of_prior", priorMatches.length ? "fail" : "pass", priorMatches.length ? `matches ${priorMatches.length} prior bill(s)` : null);

      const near = valid
        .filter(({ key: k, v: o }) => k !== key && o.bill.vendorId === bill.vendorId && o.bill.currency === bill.currency && o.bill.totalMinor === bill.totalMinor && normNumber(o.bill.billNumber) !== normNumber(bill.billNumber) && Math.abs(days(o.bill.billDate, bill.billDate)) <= 3)
        .map(({ key: k }) => k)
        .sort();
      check("near_duplicate", near.length ? "fail" : "pass", near.length ? `same vendor, currency and total within 3 days: ${near.join(", ")}` : null);

      const lineSum = sumMinor(bill.lines.map((l) => l.amountMinor));
      const lineTax = sumMinor(bill.lines.map((l) => l.taxMinor));
      if (bill.subtotalMinor === undefined) check("subtotal", "not_applicable");
      else check("subtotal", bill.subtotalMinor === lineSum ? "pass" : "fail", bill.subtotalMinor === lineSum ? null : `subtotal ${bill.subtotalMinor} ≠ lines ${lineSum}`);
      if (bill.taxMinor === undefined) check("tax", "not_applicable");
      else check("tax", bill.taxMinor === lineTax ? "pass" : "fail", bill.taxMinor === lineTax ? null : `tax ${bill.taxMinor} ≠ line taxes ${lineTax}`);
      const expectedTotal = lineSum + lineTax;
      check("total", bill.totalMinor === expectedTotal ? "pass" : "fail", bill.totalMinor === expectedTotal ? null : `total ${bill.totalMinor} ≠ lines ${lineSum} + tax ${lineTax}`);

      const foreign = bill.currency !== homeCurrency;
      check("currency_home", foreign ? "fail" : "pass", foreign ? `${bill.currency}, home currency ${homeCurrency}` : null);

      if (vendor) check("vendor_active", vendor.active ? "pass" : "fail", vendor.active ? null : `vendor ${vendor.id} is inactive`);
      else check("vendor_active", "not_applicable");
      const inactive = accountIds.filter((a) => set.accounts.get(a)?.active === false);
      check("accounts_active", inactive.length ? "fail" : unknownAccounts.length === accountIds.length ? "not_applicable" : "pass", inactive.length ? `inactive account(s): ${inactive.join(", ")}` : null);
      if (vendor?.paymentTermsDays !== undefined) {
        const expectedDue = addDays(bill.billDate, vendor.paymentTermsDays);
        check("terms", bill.dueDate === expectedDue ? "pass" : "fail", bill.dueDate === expectedDue ? null : `due ${bill.dueDate}, vendor terms ${vendor.paymentTermsDays} days give ${expectedDue}`);
      } else check("terms", "not_applicable");
      check("not_future_dated", bill.billDate > asOfDate ? "fail" : "pass", bill.billDate > asOfDate ? `bill date ${bill.billDate} is after ${asOfDate}` : null);
      check("awaiting_approval", bill.status === "draft" ? "pass" : "fail", bill.status === "draft" ? null : `status is ${bill.status}`);
      const needsDocument = foreign || bill.totalMinor > policy.documentRequiredOverMinor;
      if (!needsDocument) check("document", "not_applicable");
      else check("document", bill.documents.length ? "pass" : "fail", bill.documents.length ? null : foreign ? "foreign-currency bill without a document" : `total ${bill.totalMinor} over ${policy.documentRequiredOverMinor} without a document`);

      for (const d of bill.documents) documents.push({ billKey: key, ref: d.ref, kind: d.kind, sha256: d.sha256 ?? null, sources: [source] });
    }

    const raised: BillException[] = [];
    for (const c of checks) {
      if (c.outcome !== "fail") continue;
      const type = RAISES[c.id];
      const def = contract.exceptionTypes.get(type)!;
      const home = bill ? bill.currency === homeCurrency : true;
      const requiresReview = !!bill && ((home && bill.totalMinor > contract.reviewOverMinor) || !home || DUPLICATE_TYPES.has(type));
      raised.push({
        id: `${key}:${type}`,
        billKey: key,
        type,
        status: def.status,
        decision: def.decision as "operator" | "customer",
        requiresReview,
        amountMinor: bill?.totalMinor ?? null,
        currency: bill?.currency ?? null,
        detail: c.detail ?? "",
        sources: [source, ...references],
      });
    }
    const status = raised.length ? raised.map((e) => e.status).sort((a, b) => statusRank.get(a)! - statusRank.get(b)!)[0]! : "ready_for_payable_approval";

    const asked: InformationRequest[] = [];
    for (const e of raised) {
      const m = contract.missingInformation[e.type];
      if (m) asked.push({ id: `${key}:request:${e.type}`, billKey: key, exceptionId: e.id, ask: m.ask, detail: e.detail, blocking: m.blocking, sources: [source] });
    }

    let priority: Recommendation["priority"] = null;
    if (bill) {
      priority = bill.dueDate < asOfDate ? "overdue" : bill.dueDate <= nthBusinessDayAfter(asOfDate, policy.dueSoonBusinessDays) ? "due_soon" : "scheduled";
    }
    recommendations.push({
      billKey: key,
      recommendation: status === "ready_for_payable_approval" ? "approve_for_payment" : status === "rejected_malformed" ? "reject_resubmit" : "hold",
      advisory: true,
      vendorId: bill?.vendorId ?? null,
      billNumber: bill?.billNumber ?? null,
      amountMinor: bill?.totalMinor ?? null,
      currency: bill?.currency ?? null,
      payBy: bill?.dueDate ?? null,
      priority,
      reasons: raised.map((e) => e.type),
      sources: [source],
    });

    results.push({
      billKey: key,
      vendorId: bill?.vendorId ?? null,
      billNumber: bill?.billNumber ?? null,
      billDate: bill?.billDate ?? null,
      dueDate: bill?.dueDate ?? null,
      currency: bill?.currency ?? null,
      totalMinor: bill?.totalMinor ?? null,
      status,
      checks,
      exceptionIds: raised.map((e) => e.id),
      requestIds: asked.map((r) => r.id),
      source,
      references,
    });
    exceptions.push(...raised);
    requests.push(...asked);
  }

  results.sort(byKey);
  exceptions.sort(byId);
  requests.sort(byId);
  recommendations.sort(byKey);
  documents.sort((a, b) => (a.billKey !== b.billKey ? (a.billKey < b.billKey ? -1 : 1) : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

  const byStatus = Object.fromEntries(contract.statuses.map((s) => [s, results.filter((r) => r.status === s).length]));
  const recommended: Record<string, number> = {};
  for (const r of recommendations) if (r.recommendation === "approve_for_payment") recommended[r.currency!] = sumMinor([recommended[r.currency!] ?? 0, r.amountMinor!]);
  return {
    contract: contract.key,
    contractDigest: contract.digest,
    snapshotDigest: snapshot.digest,
    asOfDate,
    homeCurrency,
    results,
    exceptions,
    requests,
    recommendations,
    documents,
    summary: {
      bills: results.length,
      byStatus,
      exceptions: exceptions.length,
      requiringReview: exceptions.filter((e) => e.requiresReview).length,
      customerDecisions: exceptions.filter((e) => e.decision === "customer").length,
      blockingRequests: requests.filter((r) => r.blocking).length,
      recommendedForApprovalMinor: Object.fromEntries(Object.entries(recommended).sort(([a], [b]) => (a < b ? -1 : 1))),
    },
  };
}

export const outputDigest = (o: ReviewOutput) => digest(o);
