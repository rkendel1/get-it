/**
 * The review engine: classification, arithmetic, currency, duplicates, policy, missing information,
 * blocked bills, recommendations and determinism.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/canonical.js";
import { loadFrozenContract } from "../src/contract.js";
import { review, type ReviewOutput } from "../src/review.js";
import { buildSnapshot } from "../src/snapshot.js";
import { bill, billSet, SCOPE } from "./_bills.js";

const contract = loadFrozenContract();
const run = (set: unknown, scope = SCOPE) => review(buildSnapshot(scope, set, contract), contract);
const result = (o: ReviewOutput, key: string) => o.results.find((r) => r.billKey === key)!;
const types = (o: ReviewOutput, key: string) => o.exceptions.filter((e) => e.billKey === key).map((e) => e.type).sort();
const check = (o: ReviewOutput, key: string, id: string) => result(o, key).checks.find((c) => c.id === id)!;

test("every bill gets exactly one of the eight statuses", () => {
  const o = run(billSet());
  assert.deepEqual(
    Object.fromEntries(o.results.map((r) => [r.billKey, r.status])),
    {
      B1: "ready_for_payable_approval",
      B10: "blocked_pending_customer_input",
      B11: "ready_for_payable_approval",
      B2: "needs_information",
      B3: "arithmetic_exception",
      B4: "policy_exception",
      B5: "foreign_currency_review",
      B6: "duplicate_suspected",
      B7: "duplicate_suspected",
      B8: "duplicate_suspected",
      B9: "rejected_malformed",
    },
  );
  assert.deepEqual(o.summary.byStatus, {
    rejected_malformed: 1,
    blocked_pending_customer_input: 1,
    duplicate_suspected: 3,
    arithmetic_exception: 1,
    foreign_currency_review: 1,
    policy_exception: 1,
    needs_information: 1,
    ready_for_payable_approval: 2,
  });
  assert.deepEqual(o.summary.recommendedForApprovalMinor, { USD: 4320 + 2500 });
});

test("arithmetic: subtotal, tax and total are checked exactly, in integer minor units", () => {
  const o = run(billSet());
  assert.deepEqual(types(o, "B3"), ["total_mismatch"]);
  assert.equal(check(o, "B3", "total").detail, "total 7600 ≠ lines 7500 + tax 0");
  const set = billSet();
  set.bills = [
    bill({ id: "S1", vendorId: "V1", billNumber: "S1", billDate: "2026-11-02", dueDate: "2026-12-02", lines: [{ accountId: "6000", amountMinor: 1000, taxMinor: 80 }], subtotalMinor: 999, taxMinor: 80 }),
    bill({ id: "S2", vendorId: "V1", billNumber: "S2", billDate: "2026-11-02", dueDate: "2026-12-02", lines: [{ accountId: "6000", amountMinor: 2000, taxMinor: 160 }], subtotalMinor: 2000, taxMinor: 161, totalMinor: 2161 }),
    bill({ id: "S3", vendorId: "V1", billNumber: "S3", billDate: "2026-11-02", dueDate: "2026-12-02", lines: [{ accountId: "6000", amountMinor: 3000, taxMinor: 240 }], totalMinor: 3241 }),
  ];
  const s = run(set);
  assert.deepEqual(types(s, "S1"), ["subtotal_mismatch"]);
  assert.deepEqual(types(s, "S2"), ["tax_mismatch", "total_mismatch"]);
  assert.deepEqual(types(s, "S3"), ["total_mismatch"]);
  assert.equal(check(s, "S3", "subtotal").outcome, "not_applicable", "an absent subtotal is not checked");
  assert.ok(s.results.every((r) => r.status === "arithmetic_exception"));
});

test("currency: a foreign bill is never converted, always reviewed, and needs a document", () => {
  const o = run(billSet());
  const fx = o.exceptions.find((e) => e.id === "B5:foreign_currency")!;
  assert.deepEqual([fx.currency, fx.amountMinor, fx.requiresReview, fx.status], ["EUR", 90000, true, "foreign_currency_review"]);
  assert.equal(o.recommendations.find((r) => r.billKey === "B5")!.recommendation, "hold");
  assert.equal(o.summary.recommendedForApprovalMinor.EUR, undefined, "foreign amounts are never added into home totals");
  const set = billSet();
  set.bills = [bill({ id: "F1", vendorId: "V3", billNumber: "F1", billDate: "2026-11-02", dueDate: "2026-12-02", currency: "GBP", lines: [{ accountId: "6100", amountMinor: 100 }] })];
  assert.deepEqual(types(run(set), "F1"), ["document_missing", "foreign_currency"]);
  // The home currency is the order's: the same bill is domestic for a GBP customer.
  assert.deepEqual(types(run(set, { ...SCOPE, homeCurrency: "GBP" }), "F1"), []);
});

test("duplicates: same bill number in the set, a prior bill, or a near-duplicate; the customer decides", () => {
  const o = run(billSet());
  assert.deepEqual(types(o, "B6"), ["duplicate_in_set"]);
  assert.equal(check(o, "B7", "duplicate_in_set").detail, "same vendor and bill number as B6", "bill numbers compare trimmed and case-insensitive");
  const prior = o.exceptions.find((e) => e.id === "B8:duplicate_of_prior")!;
  assert.deepEqual([prior.decision, prior.requiresReview], ["customer", true]);
  assert.ok(result(o, "B8").references.some((r) => r.kind === "priorBill"), "the matching prior bill is cited");

  const set = billSet();
  set.bills = [
    bill({ id: "N1", vendorId: "V1", billNumber: "N-1", billDate: "2026-11-02", dueDate: "2026-12-02", lines: [{ accountId: "6000", amountMinor: 4321 }] }),
    bill({ id: "N2", vendorId: "V1", billNumber: "N-2", billDate: "2026-11-05", dueDate: "2026-12-05", lines: [{ accountId: "6000", amountMinor: 4321 }] }),
    bill({ id: "N3", vendorId: "V1", billNumber: "N-3", billDate: "2026-11-09", dueDate: "2026-12-09", lines: [{ accountId: "6000", amountMinor: 4321 }] }),
  ];
  const n = run(set);
  assert.deepEqual([types(n, "N1"), types(n, "N2"), types(n, "N3")], [["near_duplicate"], ["near_duplicate"], []], "N3 is 4 days from N2 and 7 from N1");
  assert.equal(check(n, "N1", "near_duplicate").detail, "same vendor, currency and total within 3 days: N2");
});

test("policy exceptions: inactive vendor or account, payment terms, future dates, bills not awaiting approval", () => {
  const o = run(billSet());
  assert.deepEqual(types(o, "B4"), ["account_inactive", "vendor_inactive"]);
  const set = billSet();
  set.bills = [
    bill({ id: "P1", vendorId: "V1", billNumber: "P1", billDate: "2026-11-02", dueDate: "2026-11-30", lines: [{ accountId: "6000", amountMinor: 101 }] }),
    bill({ id: "P2", vendorId: "V1", billNumber: "P2", billDate: "2026-11-11", dueDate: "2026-12-11", lines: [{ accountId: "6000", amountMinor: 102 }] }),
    bill({ id: "P3", vendorId: "V1", billNumber: "P3", billDate: "2026-11-02", dueDate: "2026-12-02", status: "posted", lines: [{ accountId: "6000", amountMinor: 103 }] }),
    bill({ id: "P4", vendorId: "V1", billNumber: "P4", billDate: "2026-11-02", dueDate: "2026-12-02", status: "approved", lines: [{ accountId: "6000", amountMinor: 104 }] }),
  ];
  const p = run(set);
  assert.deepEqual(types(p, "P1"), ["terms_mismatch"]);
  assert.equal(check(p, "P1", "terms").detail, "due 2026-11-30, vendor terms 30 days give 2026-12-02");
  assert.deepEqual(types(p, "P2"), ["future_dated"]);
  assert.deepEqual(types(p, "P3"), ["not_awaiting_approval"]);
  assert.deepEqual(types(p, "P4"), ["not_awaiting_approval"]);
  assert.ok(p.results.every((r) => r.status === "policy_exception"));
});

test("incomplete and blocked bills produce missing-information requests", () => {
  const o = run(billSet());
  const byId = new Map(o.requests.map((r) => [r.id, r]));
  assert.deepEqual([byId.get("B2:request:document_missing")!.blocking, byId.get("B2:request:document_missing")!.ask], [false, "a receipt or invoice document reference"]);
  assert.equal(byId.get("B10:request:vendor_unknown")!.blocking, true);
  assert.match(byId.get("B9:request:malformed_bill")!.detail, /billNumber is missing; totalMinor is not a non-negative integer of minor units; lines\[0\]\.amountMinor is not a positive integer/);
  assert.equal(o.summary.blockingRequests, 2);
  // The document threshold is the order's policy.
  const relaxed = run(billSet(), { ...SCOPE, policy: { ...SCOPE.policy, documentRequiredOverMinor: 20000 } });
  assert.equal(result(relaxed, "B2").status, "ready_for_payable_approval");
  // An unknown account blocks too, and only checks that could run did run.
  const set = billSet();
  set.bills = [bill({ id: "U1", vendorId: "V1", billNumber: "U1", billDate: "2026-11-02", dueDate: "2026-12-02", lines: [{ accountId: "7777", amountMinor: 100 }] })];
  const u = run(set);
  assert.deepEqual([result(u, "U1").status, types(u, "U1")], ["blocked_pending_customer_input", ["account_unknown"]]);
  assert.equal(check(u, "U1", "accounts_active").outcome, "not_applicable");
});

test("a malformed bill is still reported, with only the schema check run", () => {
  const o = run(billSet());
  const b9 = result(o, "B9");
  assert.deepEqual(b9.checks.filter((c) => c.outcome !== "not_applicable").map((c) => c.id), ["schema"]);
  assert.equal(o.recommendations.find((r) => r.billKey === "B9")!.recommendation, "reject_resubmit");
});

test("recommendations are advisory, with priority by business days from the review date", () => {
  const o = run(billSet());
  const rec = new Map(o.recommendations.map((r) => [r.billKey, r]));
  assert.ok(o.recommendations.every((r) => r.advisory === true));
  assert.deepEqual([rec.get("B1")!.recommendation, rec.get("B1")!.priority, rec.get("B1")!.payBy], ["approve_for_payment", "scheduled", "2026-12-02"]);
  assert.equal(rec.get("B11")!.priority, "overdue");
  // Review date Tue 2026-11-10; Wed 11-11 is Veterans Day; the 5th business day after is Wed 11-18.
  const set = billSet();
  set.bills = [
    bill({ id: "D1", vendorId: "V3", billNumber: "D1", billDate: "2026-11-02", dueDate: "2026-11-18", lines: [{ accountId: "6000", amountMinor: 100 }] }),
    bill({ id: "D2", vendorId: "V3", billNumber: "D2", billDate: "2026-11-02", dueDate: "2026-11-19", lines: [{ accountId: "6000", amountMinor: 100 }] }),
  ];
  const d = run(set);
  assert.deepEqual(d.recommendations.map((r) => r.priority), ["due_soon", "scheduled"]);
});

test("deterministic: the order of the bill set does not change the output, byte for byte", () => {
  const set = billSet();
  const reversed = { ...set, vendors: [...set.vendors].reverse(), accounts: [...set.accounts].reverse(), bills: [...set.bills].reverse() };
  assert.equal(digest(run(set)), digest(run(reversed)));
});
