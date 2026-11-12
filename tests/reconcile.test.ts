/**
 * The two-way match, rule by rule, including partial billing of a purchase order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/canonical.js";
import { loadFrozenContract } from "../src/contract.js";
import { normalizeBill, normalizePurchaseOrder } from "../src/qbo.js";
import { reconcile, type ReconciliationOutput } from "../src/reconcile.js";
import { buildSnapshot } from "../src/snapshot.js";
import { qboBill, qboPo, scenario } from "./_qbo.js";

const contract = loadFrozenContract();
const scope = { realmId: "9130", from: "2026-10-01", to: "2026-10-31", vendorIds: [] as string[], homeCurrency: "USD" };

function run(source: { bills: Record<string, any>[]; purchaseOrders: Record<string, any>[] }): ReconciliationOutput {
  return reconcile(buildSnapshot(scope, source.bills.map(normalizeBill), source.purchaseOrders.map(normalizePurchaseOrder)), contract);
}
const record = (o: ReconciliationOutput, billId: string) => o.records.find((r) => r.billId === billId)!;
const types = (o: ReconciliationOutput, billId: string) => o.exceptions.filter((e) => e.billId === billId).map((e) => e.type).sort();
const exception = (o: ReconciliationOutput, billId: string, type: string) => o.exceptions.find((e) => e.billId === billId && e.type === type)!;

test("the scenario: every status, the right exceptions, and their amounts at stake", () => {
  const o = run(scenario());
  assert.deepEqual(o.summary, { matched: 1, matched_within_tolerance: 1, discrepancy: 3, unmatched: 3, exceptions: 9, requiringReview: 1, customerDecisions: 2 });

  assert.equal(record(o, "1").status, "matched");
  assert.equal(record(o, "1").taxCents, 6000, "tax is reported, not compared");
  assert.equal(record(o, "1").expectedTotalCents, 75000);

  const b2 = record(o, "2"); // account line $1,004 against $1,000: $4 within both tolerances
  assert.equal(b2.status, "matched_within_tolerance");
  assert.deepEqual([b2.lines[0]!.unitPriceDeltaMicros, b2.totalDeltaCents, b2.totalWithin], [4_000_000, 400, true]);

  assert.equal(record(o, "3").status, "discrepancy"); // $14.00 against $12.50 × 100
  assert.deepEqual(types(o, "3"), ["price_variance", "total_variance"]);
  assert.equal(exception(o, "3", "price_variance").amountAtStakeCents, 15000);
  assert.equal(exception(o, "3", "total_variance").amountAtStakeCents, 15000);

  assert.equal(record(o, "4").status, "unmatched");
  const noPo = exception(o, "4", "no_po_reference");
  assert.deepEqual([noPo.amountAtStakeCents, noPo.requiresReview, noPo.decision], [80000, true, "operator"], "over $500: operator review");

  assert.deepEqual(types(o, "5"), ["duplicate_invoice", "no_po_reference"]);
  const dup = exception(o, "6", "duplicate_invoice");
  assert.deepEqual([dup.decision, dup.detail.duplicateOf, dup.requiresReview], ["customer", "5", false], "DocNumber compared trimmed and case-insensitive");
});

test("partial billing of a purchase order: each partial bill is a quantity variance, with the cumulative quantity", () => {
  const o = run(scenario());
  const first = exception(o, "7", "quantity_variance");
  assert.deepEqual([first.amountAtStakeCents, first.detail.billQuantityMicros, first.detail.poQuantityMicros, first.detail.cumulativeBilledQuantityMicros], [24000, 12_000_000, 20_000_000, 12_000_000]);
  const second = exception(o, "8", "quantity_variance");
  assert.deepEqual([second.amountAtStakeCents, second.detail.cumulativeBilledQuantityMicros], [36000, 20_000_000]);
  assert.ok(!o.exceptions.some((e) => e.type === "po_overbilled"), "billing exactly the PO quantity in two parts is not over-billing");
  assert.equal(record(o, "7").totalDeltaCents, 0);
});

test("over-billing beyond the PO quantity across bills", () => {
  const s = scenario();
  s.bills.push(qboBill({ id: "9", vendor: "V4", date: "2026-10-25", doc: "P-3", lines: [{ id: "1", item: "I4", qty: 5, price: 30, po: "400", poLine: "1" }] }));
  const o = run(s);
  const over = exception(o, "9", "po_overbilled");
  assert.deepEqual([over.amountAtStakeCents, over.detail.cumulativeBilledQuantityMicros], [15000, 25_000_000]);
});

test("unit price beyond tolerance with a stake over $500 requires review", () => {
  const o = run({
    bills: [qboBill({ id: "1", vendor: "V1", date: "2026-10-02", doc: "X", lines: [{ id: "1", item: "I1", qty: 1000, price: 25.6, po: "100", poLine: "1" }] })],
    purchaseOrders: [qboPo({ id: "100", vendor: "V1", lines: [{ id: "1", item: "I1", qty: 1000, price: 25 }] })],
  });
  // $25.60 against $25.00: $0.60 is within the greater of $1 and 1% ($0.25).
  assert.equal(exception(o, "1", "price_variance"), undefined);
  const o2 = run({
    bills: [qboBill({ id: "1", vendor: "V1", date: "2026-10-02", doc: "X", lines: [{ id: "1", item: "I1", qty: 1000, price: 26.01, po: "100", poLine: "1" }] })],
    purchaseOrders: [qboPo({ id: "100", vendor: "V1", lines: [{ id: "1", item: "I1", qty: 1000, price: 25 }] })],
  });
  const pv = exception(o2, "1", "price_variance");
  assert.deepEqual([pv.amountAtStakeCents, pv.requiresReview], [101000, true]);
});

test("supplier and currency mismatches; a foreign-currency exception always needs review", () => {
  const o = run({
    bills: [
      qboBill({ id: "1", vendor: "V9", date: "2026-10-02", lines: [{ id: "1", item: "I1", qty: 1, price: 10, po: "100", poLine: "1" }] }),
      qboBill({ id: "2", vendor: "V1", date: "2026-10-02", currency: "EUR", lines: [{ id: "1", item: "I1", qty: 1, price: 10, po: "100", poLine: "1" }] }),
    ],
    purchaseOrders: [qboPo({ id: "100", vendor: "V1", lines: [{ id: "1", item: "I1", qty: 2, price: 10 }] })],
  });
  assert.deepEqual([exception(o, "1", "supplier_mismatch").decision, record(o, "1").status], ["customer", "discrepancy"]);
  const fx = exception(o, "2", "currency_mismatch");
  assert.deepEqual([fx.amountAtStakeCents, fx.requiresReview, fx.currency], [1000, true, "EUR"], "no conversion: review regardless of amount");
});

test("PO not found, and PO lines that cannot be resolved", () => {
  const o = run({
    bills: [
      qboBill({ id: "1", vendor: "V1", date: "2026-10-02", doc: "N-1", lines: [{ id: "1", item: "I1", qty: 1, price: 10, po: "555", poLine: "1" }] }),
      qboBill({ id: "2", vendor: "V1", date: "2026-10-02", doc: "N-2", lines: [{ id: "1", item: "I1", qty: 1, price: 10, po: "100" }] }), // no TxnLineId; I1 is on two PO lines
      qboBill({ id: "3", vendor: "V1", date: "2026-10-02", doc: "N-3", lines: [{ id: "1", item: "I2", qty: 3, price: 7, po: "100" }] }), // no TxnLineId; I2 is unique
      qboBill({ id: "4", vendor: "V1", date: "2026-10-02", doc: "N-4", lines: [{ id: "1", item: "I1", qty: 1, price: 10, po: "100", poLine: "99" }] }), // names a line the PO lacks
    ],
    purchaseOrders: [qboPo({ id: "100", vendor: "V1", lines: [{ id: "1", item: "I1", qty: 1, price: 10 }, { id: "2", item: "I1", qty: 1, price: 10 }, { id: "3", item: "I2", qty: 3, price: 7 }] })],
  });
  assert.deepEqual([record(o, "1").status, types(o, "1")], ["unmatched", ["po_not_found"]]);
  assert.deepEqual([record(o, "2").status, types(o, "2"), exception(o, "2", "po_line_ambiguous").decision], ["discrepancy", ["po_line_ambiguous"], "customer"]);
  assert.deepEqual([record(o, "3").status, record(o, "3").lines[0]!.poLineId], ["matched", "3"], "a unique item resolves the line");
  assert.deepEqual(types(o, "4"), ["po_line_ambiguous"]);
});

test("deterministic: input order does not change the output, byte for byte", () => {
  const s = scenario();
  const a = run(s);
  const b = run({ bills: [...s.bills].reverse(), purchaseOrders: [...s.purchaseOrders].reverse() });
  assert.equal(digest(a), digest(b));
});
