/**
 * Contracts are frozen and versions are immutable:
 * - the active contract matches its pinned digest;
 * - any edit, or a new version that was never frozen, is refused;
 * - the retired version keeps its pin forever and cannot be loaded or reused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import active from "../contracts/svc_bill_review_payable_prep@1.0.0.json" with { type: "json" };
import { CONTRACT_KEY, ContractError, contractDigest, loadFrozenContract, PINS, type ContractDocument } from "../src/contract.js";

test("svc_bill_review_payable_prep@1.0.0 is active and matches its pinned digest", () => {
  const c = loadFrozenContract();
  assert.equal(c.key, "svc_bill_review_payable_prep@1.0.0");
  assert.equal(CONTRACT_KEY, c.key);
  assert.equal(c.digest, "sha256:6097d09b5f39d202412bae4e69ad94e45768829c1f9149f12cc7648863f3c637");
  assert.equal(contractDigest(), c.digest);
  assert.deepEqual(PINS[c.key], { digest: c.digest, status: "active" });
  assert.equal(c.contract.status, "frozen");
});

test("version immutability: an edited contract, or an unfrozen version, is refused", () => {
  const edited = structuredClone(active) as ContractDocument;
  edited.commercial.pricing.perAdditionalBillMinor = 199;
  assert.throws(() => loadFrozenContract(edited), (e: unknown) => e instanceof ContractError && /changed after freezing/.test(e.message));
  const bumped = { ...structuredClone(active), version: "1.0.1" } as ContractDocument;
  assert.throws(() => loadFrozenContract(bumped), (e: unknown) => e instanceof ContractError && /not frozen/.test(e.message));
});

test("the retired contract keeps its pin and can never be loaded or reused", () => {
  const retired = PINS["svc_invoice_reconciliation@1.0.0"]!;
  assert.equal(retired.status, "retired");
  assert.equal(retired.digest, "sha256:5f99cb1826c40d4eac399f80aa183be88c5cce35518efce889b2f5801a964d40");
  const reuse = { ...structuredClone(active), id: "svc_invoice_reconciliation", version: "1.0.0" } as ContractDocument;
  assert.throws(() => loadFrozenContract(reuse), (e: unknown) => e instanceof ContractError && /is retired/.test(e.message));
  assert.equal(Object.values(PINS).filter((p) => p.status === "active").length, 1);
});

test("the contract defines what was asked, and nothing it must not", () => {
  const c = loadFrozenContract();
  const doc = c.contract;
  assert.deepEqual(doc.inputs.required.map((i) => i.id), ["bills", "vendors", "accounts", "homeCurrency", "timeZone", "asOfDate"]);
  assert.deepEqual(doc.inputs.optional.map((i) => i.id), ["priorBills", "policy.documentRequiredOverMinor", "policy.dueSoonBusinessDays"]);
  assert.deepEqual(doc.fields.vendor.required, ["id", "name", "active"]);
  assert.deepEqual(doc.fields.bill.required, ["id", "vendorId", "billNumber", "billDate", "dueDate", "currency", "status", "lines", "totalMinor"]);
  assert.deepEqual(doc.fields.line.required, ["description", "accountId", "amountMinor"]);
  assert.match(doc.currency.conversion, /never converts/);
  assert.deepEqual(c.statuses, ["rejected_malformed", "blocked_pending_customer_input", "duplicate_suspected", "arithmetic_exception", "foreign_currency_review", "policy_exception", "needs_information", "ready_for_payable_approval"]);
  assert.equal(c.exceptionTypes.size, 16);
  assert.equal(c.reviewOverMinor, 50_000);
  assert.deepEqual(c.deliverableFiles.sort(), ["approval-packet.json", "bill-review-results.csv", "bill-review-results.json", "evidence.json", "exceptions.csv", "exceptions.json", "missing-information-requests.json", "payable-recommendation.csv", "payable-recommendation.json", "source-document-references.json", "summary.csv"]);
  assert.equal(doc.acceptanceCriteria.length, 8);
  assert.deepEqual(c.pricing, { basePerRunMinor: 25_000, includedBills: 100, perAdditionalBillMinor: 200 });
  assert.deepEqual([c.service.turnaroundBusinessDays, c.service.correctionWindowBusinessDays, c.service.blockedLimitBusinessDays], [2, 5, 10]);
  assert.match(doc.commercial.charging.partial, /number of bills accepted/);
  assert.match(doc.commercial.charging.failedWork, /not charged/);
  for (const action of ["approve, post, pay, void", "record or schedule a payment", "send email", "read or write an accounting system", "convert currencies", "match purchase orders, quantities, unit prices"]) {
    assert.ok(doc.boundaries.excludedActions.some((x) => x.includes(action)), action);
  }
  const text = JSON.stringify(doc).toLowerCase();
  for (const word of ["quickbooks", "qbo", "oauth", "purchaseorder"]) assert.ok(!text.includes(word), `the contract does not mention ${word}`);
});
