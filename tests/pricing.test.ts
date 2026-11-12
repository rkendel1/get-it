/**
 * Price and charging: $250 per run including 100 invoices, $2 per additional invoice; platform
 * failures free; partial work charged only when accepted, on the invoices accepted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFrozenContract } from "../src/contract.js";
import { charge, runPriceCents } from "../src/pricing.js";

const p = loadFrozenContract().pricing;

test("run price", () => {
  assert.equal(runPriceCents(0, p), 25_000);
  assert.equal(runPriceCents(100, p), 25_000);
  assert.equal(runPriceCents(101, p), 25_200);
  assert.equal(runPriceCents(250, p), 55_000);
  assert.throws(() => runPriceCents(-1, p));
  assert.throws(() => runPriceCents(1.5, p));
});

test("charging outcomes", () => {
  assert.equal(charge({ kind: "delivered", invoicesCounted: 130 }, p).cents, 31_000);
  assert.equal(charge({ kind: "platform_failure" }, p).cents, 0);
});

test("partial work is charged only when the customer accepts it, by the invoices accepted", () => {
  assert.equal(charge({ kind: "partial", customerAcceptedPortion: false, invoicesAccepted: 90 }, p).cents, 0);
  assert.equal(charge({ kind: "partial", customerAcceptedPortion: true, invoicesAccepted: 40 }, p).cents, 25_000);
  assert.equal(charge({ kind: "partial", customerAcceptedPortion: true, invoicesAccepted: 130 }, p).cents, 31_000);
  assert.equal(charge({ kind: "partial", customerAcceptedPortion: true, invoicesAccepted: 0 }, p).cents, 0);
  assert.equal(charge({ kind: "cancelled", customerAcceptedPortion: false, invoicesAccepted: 0 }, p).cents, 0);
  assert.equal(charge({ kind: "cancelled", customerAcceptedPortion: true, invoicesAccepted: 120 }, p).cents, 29_000);
});
