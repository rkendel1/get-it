/**
 * Integer-cent money and the contract's tolerance arithmetic: exact at the boundaries, no floats.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFrozenContract } from "../src/contract.js";
import { AmountError, cents, extendCents, micros } from "../src/money.js";
import { quantityWithin, totalWithin, unitPriceWithin } from "../src/tolerance.js";

const t = loadFrozenContract().tolerances;
const $ = (dollars: string) => micros(dollars); // unit prices in micros

test("amounts parse from decimal text into integer cents, never through float arithmetic", () => {
  assert.equal(cents(0.1) + cents(0.2), 30); // 0.1 + 0.2 = 0.30000000000000004 as floats
  assert.equal(cents(19.99), 1999);
  assert.equal(cents("1234.5"), 123450);
  assert.equal(cents(-7.05), -705);
  assert.equal(micros(1e-6), 1); // exponent form expands exactly
  assert.throws(() => cents(1e21), AmountError, "beyond safe integers is refused");
  assert.throws(() => cents(1.005), AmountError, "more than 2 decimals is refused, not rounded");
  assert.throws(() => cents("12,00"), AmountError);
  assert.throws(() => cents(Number.NaN), AmountError);
  assert.equal(micros(4.567891), 4_567_891);
  assert.throws(() => micros("1.0000001"), AmountError);
});

test("extensions round half away from zero once, in BigInt", () => {
  assert.equal(extendCents(micros(3), micros(33.335)), 10001); // 100.005 → 100.01
  assert.equal(extendCents(micros(1.5), micros(33.33)), 5000); // 49.995 → 50.00
  assert.equal(extendCents(micros(1_000_000), micros(9_999.999999)), 999_999_999_900); // beyond 2^53 micros², exact
});

test("unit price: the greater of $1 or 1% of the PO unit price, inclusive", () => {
  // PO $50.00: 1% = $0.50, so $1 applies.
  assert.ok(unitPriceWithin($("51"), $("50"), t));
  assert.ok(unitPriceWithin($("49"), $("50"), t));
  assert.ok(!unitPriceWithin($("51.000001"), $("50"), t));
  // PO $500.00: 1% = $5.00 applies.
  assert.ok(unitPriceWithin($("505"), $("500"), t));
  assert.ok(!unitPriceWithin($("505.000001"), $("500"), t));
  // Exactly $100: both bounds are $1.
  assert.ok(unitPriceWithin($("101"), $("100"), t));
  assert.ok(!unitPriceWithin($("101.01"), $("100"), t));
});

test("quantity: exact, no tolerance at all", () => {
  assert.ok(quantityWithin(micros(10), micros(10), t));
  assert.ok(!quantityWithin(micros(10.000001), micros(10), t));
  assert.ok(!quantityWithin(micros(9), micros(10), t));
});

test("invoice total: the greater of $5 or 0.5% of the expected total, inclusive", () => {
  assert.ok(totalWithin(cents(105), cents(100), t)); // 0.5% = $0.50, $5 applies
  assert.ok(!totalWithin(cents(105.01), cents(100), t));
  assert.ok(totalWithin(cents(10_050), cents(10_000), t)); // 0.5% = $50 applies
  assert.ok(!totalWithin(cents(10_050.01), cents(10_000), t));
  assert.ok(totalWithin(cents(995), cents(1000), t)); // $5 = 0.5% of $1000: the bounds coincide
  assert.ok(!totalWithin(cents(994.99), cents(1000), t));
});
