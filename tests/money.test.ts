/**
 * Integer minor units: amounts are safe integers, sums are exact, nothing is a float.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMinor, isMinor, sumMinor } from "../src/money.js";

test("an amount is a safe integer of minor units", () => {
  assert.ok(isMinor(0));
  assert.ok(isMinor(4320));
  assert.ok(!isMinor(12.5), "a decimal is not an amount");
  assert.ok(!isMinor("4320"), "a string is not an amount");
  assert.ok(!isMinor(Number.NaN));
  assert.ok(!isMinor(2 ** 53), "beyond the safe range");
  assert.ok(!isMinor(-1));
  assert.ok(!isMinor(0, 1), "a line amount must be at least 1");
});

test("sums are exact and refuse overflow instead of rounding", () => {
  assert.equal(sumMinor([10, 20]), 30); // 0.10 + 0.20 = 0.30 exactly
  assert.equal(sumMinor([Number.MAX_SAFE_INTEGER - 1, 1]), Number.MAX_SAFE_INTEGER);
  assert.throws(() => sumMinor([Number.MAX_SAFE_INTEGER, 1]), RangeError);
});

test("display form keeps two decimals", () => {
  assert.equal(formatMinor(432_000), "4320.00");
  assert.equal(formatMinor(5), "0.05");
  assert.equal(formatMinor(-1999), "-19.99");
});
