/**
 * Ledger-compatible inputs: malformed and incomplete bills, and bill sets refused for invalid
 * reference data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BillSetError, billKey, isCalendarDate, validateBill, validateBillSet } from "../src/bills.js";
import { loadFrozenContract } from "../src/contract.js";
import { accounts, bill, billSet, vendors } from "./_bills.js";

const limits = loadFrozenContract().limits;
const issuesOf = (raw: unknown) => {
  const v = validateBill(raw, limits.maxLinesPerBill);
  return v.ok ? [] : v.issues;
};

test("a Ledger bill with the contract's fields validates, and Ledger-only members are ignored", () => {
  const v = validateBill(billSet().bills[0], limits.maxLinesPerBill);
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.deepEqual(v.bill.lines, [{ description: "Paper", accountId: "6000", amountMinor: 4000, taxMinor: 320 }]);
  assert.equal(v.bill.totalMinor, 4320);
  assert.equal((v.bill as unknown as Record<string, unknown>).journalEntryId, undefined);
});

test("malformed bills: every missing or invalid required field is named", () => {
  const base = { id: "B", vendorId: "V1", billNumber: "N", billDate: "2026-11-02", dueDate: "2026-12-02", lines: [{ accountId: "6000", amountMinor: 100 }] };
  assert.deepEqual(issuesOf("not a bill"), ["a bill must be an object"]);
  assert.match(issuesOf({ ...bill(base), billNumber: undefined }).join(), /billNumber is missing/);
  assert.match(issuesOf({ ...bill(base), billNumber: "   " }).join(), /billNumber is missing/);
  assert.match(issuesOf({ ...bill(base), billDate: "2026-02-30" }).join(), /billDate is not a calendar date/);
  assert.match(issuesOf({ ...bill(base), dueDate: "2026-10-01" }).join(), /dueDate is before billDate/);
  assert.match(issuesOf({ ...bill(base), currency: "usd" }).join(), /currency is not an ISO 4217 code/);
  assert.match(issuesOf({ ...bill(base), status: "paid" }).join(), /status must be one of draft, approved, posted, void/);
  assert.match(issuesOf({ ...bill(base), totalMinor: 1.5 }).join(), /totalMinor is not a non-negative integer/);
  assert.match(issuesOf({ ...bill(base), totalMinor: "100" }).join(), /totalMinor is not a non-negative integer/);
  assert.match(issuesOf({ ...bill(base), lines: [] }).join(), /lines must be a non-empty list/);
  assert.match(issuesOf(bill({ ...base, lines: [{ accountId: "6000", amountMinor: 0 }] })).join(), /lines\[0\]\.amountMinor is not a positive integer/);
  assert.match(issuesOf(bill({ ...base, lines: [{ accountId: "6000", amountMinor: 100, taxMinor: -1 }] })).join(), /lines\[0\]\.taxMinor/);
  assert.match(issuesOf(bill({ ...base, lines: [{ description: "", accountId: "6000", amountMinor: 100 }] })).join(), /lines\[0\]\.description is missing/);
  assert.match(issuesOf(bill({ ...base, documents: [{ kind: "receipt" }] })).join(), /documents\[0\]\.ref is missing/);
  assert.match(issuesOf(bill({ ...base, documents: [{ ref: "r", sha256: "xyz" }] })).join(), /documents\[0\]\.sha256/);
  // Several problems at once are all reported.
  assert.equal(issuesOf({ id: "B", vendorId: "V1" }).length, 7);
});

test("a bill without a usable id is keyed by its content", () => {
  assert.equal(billKey({ id: "B1" }), "B1");
  assert.match(billKey({ id: "has spaces" }), /^malformed:[0-9a-f]{16}$/);
  assert.equal(billKey({ vendorId: "V1" }), billKey({ vendorId: "V1" }));
  assert.ok(isCalendarDate("2028-02-29") && !isCalendarDate("2027-02-29"));
});

test("invalid reference data or a bill-key clash refuses the whole set, listing every issue", () => {
  const set = billSet();
  assert.doesNotThrow(() => validateBillSet(set, limits));
  const refused = (raw: unknown, pattern: RegExp) => assert.throws(() => validateBillSet(raw, limits), (e: unknown) => e instanceof BillSetError && e.issues.some((i) => pattern.test(i)));
  refused({ ...set, bills: [] }, /at least one bill/);
  refused({ ...set, vendors: [...vendors, { id: "V1", name: "Again", active: true }] }, /vendor V1 appears twice/);
  refused({ ...set, vendors: [{ id: "V1", name: "No active flag" }] }, /active must be true or false/);
  refused({ ...set, accounts: [...accounts, { id: "6000", name: "Again", active: true }] }, /account 6000 appears twice/);
  refused({ ...set, bills: [...set.bills, set.bills[0]] }, /bill key B1 also used/);
  refused({ ...set, priorBills: [{ vendorId: "V1" }] }, /priorBills\[0\]\.billNumber is missing/);
  refused({ ...set, bills: Array.from({ length: limits.maxBills + 1 }, (_, i) => ({ id: `X${i}` })) }, /more than 1000/);
  refused({ vendors: [], accounts: [] }, /bills must be a list/);
});
