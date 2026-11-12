/**
 * The contract is frozen: its content matches the pinned digest, and its terms are the ones the
 * owner decided on 2026-11-12. Changing a term is a new version; this test fails on an in-place
 * edit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import contractJson from "../contracts/svc_invoice_reconciliation@1.0.0.json" with { type: "json" };
import frozen from "../contracts/frozen.json" with { type: "json" };
import { contractDigest, loadFrozenContract } from "../src/contract.js";

test("svc_invoice_reconciliation@1.0.0 matches its pinned digest", () => {
  const c = loadFrozenContract();
  assert.equal(c.key, "svc_invoice_reconciliation@1.0.0");
  assert.equal(c.digest, (frozen as Record<string, string>)["svc_invoice_reconciliation@1.0.0"]);
  assert.equal(c.contract.status, "frozen");
});

test("any edit to the frozen contract changes its digest", () => {
  const edited = structuredClone(contractJson);
  edited.tolerances.invoiceTotal.absoluteCents = 501;
  assert.notEqual(contractDigest(edited), loadFrozenContract().digest);
});

test("the frozen terms are the agreed defaults", () => {
  const c = loadFrozenContract();
  assert.deepEqual(
    { unitPrice: c.tolerances.unitPrice, quantity: c.tolerances.quantity, invoiceTotal: c.tolerances.invoiceTotal },
    {
      unitPrice: { ...c.contract.tolerances.unitPrice, rule: "greater_of", absoluteMicros: 1_000_000, basisPoints: 100 }, // $1 or 1%
      quantity: { ...c.contract.tolerances.quantity, rule: "exact" },
      invoiceTotal: { ...c.contract.tolerances.invoiceTotal, rule: "greater_of", absoluteCents: 500, basisPoints: 50 }, // $5 or 0.5%
    },
  );
  assert.equal(c.reviewOverCents, 50_000); // exceptions over $500
  assert.deepEqual(c.pricing, { basePerRunCents: 25_000, includedInvoices: 100, perAdditionalInvoiceCents: 200 });
  assert.equal(c.service.turnaroundBusinessDays, 2);
  assert.equal(c.service.correctionWindowBusinessDays, 5);
  assert.equal(c.service.blockedLimitBusinessDays, 10);
  assert.equal(c.contract.source.system, "quickbooks-online");
  assert.equal(c.contract.source.access, "operationally-read-only");
  assert.match(c.contract.source.accessNote, /can technically write/);
  assert.match(c.contract.commercial.charging.partial, /number of invoices accepted/);
  assert.match(c.contract.calendar.businessDays, /Monday to Friday, excluding US federal holidays .* in the customer's time zone/);
  assert.deepEqual([...c.customerDecisionTypes].sort(), ["duplicate_invoice", "po_line_ambiguous", "supplier_mismatch"]);
  assert.ok(c.contract.matching.excluded.includes("three-way match (receipt of goods)"));
});
