/**
 * Price and charging: $250 per run including 100 bills, $2 per additional bill. Platform failures
 * and failed acceptance are free. Partial work is charged only when accepted, on the bills accepted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFrozenContract } from "../src/contract.js";
import { charge, runPriceMinor } from "../src/pricing.js";

const p = loadFrozenContract().pricing;

test("run price", () => {
  assert.equal(runPriceMinor(0, p), 25_000);
  assert.equal(runPriceMinor(100, p), 25_000);
  assert.equal(runPriceMinor(101, p), 25_200);
  assert.equal(runPriceMinor(250, p), 55_000);
  assert.throws(() => runPriceMinor(-1, p));
  assert.throws(() => runPriceMinor(1.5, p));
});

test("failed work is not charged", () => {
  assert.equal(charge({ kind: "platform_failure" }, p).minor, 0);
  assert.equal(charge({ kind: "failed_acceptance" }, p).minor, 0);
  assert.equal(charge({ kind: "accepted", billsCounted: 130 }, p).minor, 31_000);
});

test("partial work is charged only when the customer accepts it, by the bills accepted", () => {
  assert.equal(charge({ kind: "partial", customerAcceptedPortion: false, billsAccepted: 90 }, p).minor, 0);
  assert.equal(charge({ kind: "partial", customerAcceptedPortion: true, billsAccepted: 40 }, p).minor, 25_000);
  assert.equal(charge({ kind: "partial", customerAcceptedPortion: true, billsAccepted: 130 }, p).minor, 31_000);
  assert.equal(charge({ kind: "partial", customerAcceptedPortion: true, billsAccepted: 0 }, p).minor, 0);
  assert.equal(charge({ kind: "cancelled", customerAcceptedPortion: false, billsAccepted: 0 }, p).minor, 0);
  assert.equal(charge({ kind: "cancelled", customerAcceptedPortion: true, billsAccepted: 120 }, p).minor, 29_000);
});
