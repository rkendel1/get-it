/**
 * Intake rules, derived from the frozen contract: which inputs are answered and which come from the
 * bill set, how answers are validated, what blocks completion, and the assumptions recorded for
 * declined optional inputs. Pure: no FeltKit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/canonical.js";
import { loadFrozenContract } from "../src/contract.js";
import { completeness, inputSpecs, validateAnswer, type AnswerState } from "../src/intake.js";
import { addressBillSet, buildSnapshot } from "../src/snapshot.js";
import { billSet, SCOPE } from "./_bills.js";

const contract = loadFrozenContract();
const spec = (id: string) => inputSpecs(contract).find((s) => s.id === id)!;

test("the contract's inputs split into answered inputs and bill-set inputs", () => {
  const specs = inputSpecs(contract);
  assert.deepEqual(specs.filter((s) => s.source === "answer").map((s) => [s.id, s.required]), [
    ["homeCurrency", true],
    ["timeZone", true],
    ["asOfDate", true],
    ["policy.documentRequiredOverMinor", false],
    ["policy.dueSoonBusinessDays", false],
  ]);
  assert.deepEqual(specs.filter((s) => s.source === "bill set").map((s) => [s.id, s.required]), [
    ["bills", true],
    ["vendors", true],
    ["accounts", true],
    ["priorBills", false],
  ]);
});

test("answers are validated against the contract's kind and range", () => {
  assert.deepEqual(validateAnswer(spec("homeCurrency"), "EUR"), { ok: true, value: "EUR" });
  assert.equal(validateAnswer(spec("homeCurrency"), "eur").ok, false);
  assert.equal(validateAnswer(spec("homeCurrency"), 978).ok, false, "wrong type");
  assert.equal(validateAnswer(spec("timeZone"), "Europe/Berlin").ok, true);
  assert.equal(validateAnswer(spec("timeZone"), "Mars/Olympus").ok, false);
  assert.equal(validateAnswer(spec("asOfDate"), "2026-02-30").ok, false);
  assert.equal(validateAnswer(spec("asOfDate"), "2026-11-10").ok, true);
  // Integer ranges come from the contract: [0, 100000000] and [1, 30].
  assert.equal(validateAnswer(spec("policy.documentRequiredOverMinor"), 0).ok, true);
  assert.equal(validateAnswer(spec("policy.documentRequiredOverMinor"), 100_000_000).ok, true);
  assert.equal(validateAnswer(spec("policy.documentRequiredOverMinor"), 100_000_001).ok, false);
  assert.equal(validateAnswer(spec("policy.documentRequiredOverMinor"), -1).ok, false);
  assert.equal(validateAnswer(spec("policy.documentRequiredOverMinor"), 75.5).ok, false, "not an integer");
  assert.equal(validateAnswer(spec("policy.documentRequiredOverMinor"), "7500").ok, false, "wrong type");
  assert.equal(validateAnswer(spec("policy.dueSoonBusinessDays"), 31).ok, false);
  assert.equal(validateAnswer(spec("policy.dueSoonBusinessDays"), 0).ok, false);
  const refused = validateAnswer(spec("policy.dueSoonBusinessDays"), 31);
  assert.ok(!refused.ok && /between 1 and 30/.test(refused.issue));
});

const answered = (extra: Record<string, AnswerState> = {}): Map<string, AnswerState> =>
  new Map<string, AnswerState>(Object.entries({ homeCurrency: { kind: "answer", value: "USD" }, timeZone: { kind: "answer", value: "America/New_York" }, asOfDate: { kind: "answer", value: "2026-11-10" }, ...extra }));

test("required inputs block completion: every missing one is named", () => {
  const none = completeness(contract, new Map(), null);
  assert.equal(none.complete, false);
  assert.deepEqual(none.missing, ["homeCurrency", "timeZone", "asOfDate", "bills", "vendors", "accounts"]);
  const noBills = completeness(contract, answered(), null);
  assert.deepEqual(noBills.missing, ["bills", "vendors", "accounts"]);
  const address = addressBillSet(billSet(), contract);
  assert.equal(completeness(contract, answered(), address).complete, true);
});

test("declined or unanswered optional inputs become explicit assumptions; defaults apply", () => {
  const address = addressBillSet({ ...billSet(), priorBills: undefined }, contract);
  const c = completeness(contract, answered({ "policy.documentRequiredOverMinor": { kind: "decline" } }), address);
  assert.ok(c.complete);
  assert.deepEqual(c.assumptions, [
    { input: "policy.documentRequiredOverMinor", how: "declined", statement: "policy.documentRequiredOverMinor was declined: the contract default 7500 applies." },
    { input: "policy.dueSoonBusinessDays", how: "not_answered", statement: "policy.dueSoonBusinessDays was not answered: the contract default 5 applies." },
    { input: "priorBills", how: "not_supplied", statement: "priorBills was not supplied (bills already processed, for duplicate detection): the review proceeds without it." },
  ]);
  assert.deepEqual(c.bindings, { homeCurrency: "USD", timeZone: "America/New_York", asOfDate: "2026-11-10", policy: { documentRequiredOverMinor: 7500, dueSoonBusinessDays: 5 } });
  // An answered optional input is bound, not assumed.
  const answeredPolicy = completeness(contract, answered({ "policy.dueSoonBusinessDays": { kind: "answer", value: 3 } }), addressBillSet(billSet(), contract));
  assert.deepEqual(answeredPolicy.assumptions.map((a) => a.input), ["policy.documentRequiredOverMinor"]);
  assert.equal(answeredPolicy.bindings.policy.dueSoonBusinessDays, 3);
});

test("a complete intake produces a deterministic completeness report bound to the contract", () => {
  const set = billSet();
  const a = completeness(contract, answered(), addressBillSet(set, contract));
  const reversed = { ...set, bills: [...set.bills].reverse(), vendors: [...set.vendors].reverse() };
  const b = completeness(contract, new Map([...answered()].reverse()), addressBillSet(reversed, contract));
  assert.equal(digest(a.report), digest(b.report));
  assert.equal(a.report.contract, "svc_bill_review_payable_prep@1.0.0");
  assert.equal(a.report.contractDigest, contract.digest);
  assert.deepEqual(a.report.billSet, { digest: a.report.billSet!.digest, bills: 11, vendors: 3, accounts: 3, priorBills: 1 });
  assert.deepEqual(a.report.inputs.map((i) => [i.id, i.status]), [
    ["homeCurrency", "bound"],
    ["timeZone", "bound"],
    ["asOfDate", "bound"],
    ["bills", "bound"],
    ["vendors", "bound"],
    ["accounts", "bound"],
    ["policy.documentRequiredOverMinor", "assumed"],
    ["policy.dueSoonBusinessDays", "assumed"],
    ["priorBills", "bound"],
  ]);
});

test("intake and import share one bill-set validator: buildSnapshot is addressBillSet plus the review scope", () => {
  const address = addressBillSet(billSet(), contract);
  const snap = buildSnapshot(SCOPE, billSet(), contract);
  assert.deepEqual(snap.manifest, address.manifest);
  assert.deepEqual(snap.records, address.records);
  const bad = { ...billSet(), vendors: [{ id: "V1" }] };
  assert.throws(() => addressBillSet(bad, contract), /vendors\[0\]\.name is missing/);
  assert.throws(() => buildSnapshot(SCOPE, bad, contract), /vendors\[0\]\.name is missing/);
});
