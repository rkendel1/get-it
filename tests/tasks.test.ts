/**
 * General task requests, the pure rules: proposing a real fulfillment path (and only that), the
 * task's state from its facts, and validation of what customers and operators record.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { proposePath, taskState, validateDetail, validateQuestions, type Assessment } from "../src/tasks.js";

const BILL_REVIEW = { service: "svc_bill_review_payable_prep@1.0.0", title: "Bill review and payable preparation", signals: ["bill", "bills", "invoice", "invoices", "payable", "payables", "accounts payable"] };

test("only a description that names the supported service's subject proposes it; everything else proposes nothing", () => {
  assert.deepEqual(proposePath("Review the supplier BILLS before Friday's payment run.", [BILL_REVIEW])?.matched, ["bills"]);
  assert.deepEqual(proposePath("I need these invoices organized.", [BILL_REVIEW])?.matched, ["invoices"]);
  for (const text of ["Build me a website.", "Research these five competitors.", "Clean up my customer database.", "Move my application to a new server.", "Find someone who can repair my deck.", "I need help organizing an event.", "Create a presentation from these documents.", "Billing system migration"]) {
    assert.equal(proposePath(text, [BILL_REVIEW]), null, text);
  }
  assert.equal(proposePath("anything", []), null, "no paths, no proposal");
});

const at = (n: number) => 1_000 + n;
const assessment = (a: Partial<Assessment>): Assessment => ({ outcome: "requires_manual_review", reasons: [], questions: [], arrangements: [], at: at(0), ...a });

test("a task's state comes from its facts only", () => {
  assert.equal(taskState({ assessments: [], details: [], link: null, pathDeclined: false }).outcome, "ready_to_scope");

  const proposed = assessment({ outcome: "fulfillment_path_identified", service: BILL_REVIEW.service });
  assert.deepEqual(taskState({ assessments: [proposed], details: [], link: null, pathDeclined: false }), { outcome: "fulfillment_path_identified", openQuoteQuestions: [], service: BILL_REVIEW.service, confirmed: false, declined: false });
  assert.equal(taskState({ assessments: [proposed], details: [], link: null, pathDeclined: true }).outcome, "requires_manual_review", "a declined proposal goes to a person");
  assert.equal(taskState({ assessments: [proposed], details: [], link: { intakeComplete: false }, pathDeclined: false }).outcome, "fulfillment_path_identified");
  assert.equal(taskState({ assessments: [proposed], details: [], link: { intakeComplete: true }, pathDeclined: false }).outcome, "ready_to_quote");

  // More information: open until every question needed to quote is answered, then back to a person.
  const info = assessment({ outcome: "more_information_required", at: at(1), questions: [{ id: "pages", text: "How many pages?", purpose: "quote" }, { id: "logo", text: "Do you have a logo?", purpose: "resource" }] });
  const s1 = taskState({ assessments: [proposed, info], details: [], link: null, pathDeclined: false });
  assert.deepEqual([s1.outcome, s1.openQuoteQuestions.map((q) => q.id)], ["more_information_required", ["pages"]]);
  const s2 = taskState({ assessments: [info], details: [{ kind: "answer", questionId: "pages", value: "5", at: at(2) }], link: null, pathDeclined: false });
  assert.equal(s2.outcome, "requires_manual_review");

  // The latest assessment wins; an honest "not now" stays "not now".
  const no = assessment({ outcome: "not_currently_fulfillable", at: at(3), reasons: ["Needs licensed onsite work we cannot arrange yet."] });
  assert.equal(taskState({ assessments: [info, no], details: [], link: null, pathDeclined: false }).outcome, "not_currently_fulfillable");
  const external = assessment({ outcome: "requires_external_provider", at: at(4) });
  assert.equal(taskState({ assessments: [no, external], details: [], link: null, pathDeclined: false }).outcome, "requires_external_provider");
});

test("details and questions are validated", () => {
  assert.equal(validateDetail("deadline", "2026-12-01"), "2026-12-01");
  assert.throws(() => validateDetail("deadline", "next week"));
  assert.deepEqual(validateDetail("budget", { amountMinor: 50_000, currency: "USD" }), { amountMinor: 50_000, currency: "USD" });
  assert.throws(() => validateDetail("budget", { amountMinor: 500.5, currency: "USD" }));
  assert.throws(() => validateDetail("budget", { amountMinor: 500, currency: "usd" }));
  assert.equal(validateDetail("constraint", "  Must be done by an insured contractor. "), "Must be done by an insured contractor.");
  assert.throws(() => validateDetail("note", ""));
  assert.deepEqual(validateQuestions([{ id: "pages", text: "How many pages?", purpose: "quote" }]), [{ id: "pages", text: "How many pages?", purpose: "quote" }]);
  assert.throws(() => validateQuestions([{ id: "Pages!", text: "x", purpose: "quote" }]));
  assert.throws(() => validateQuestions([{ id: "a", text: "x", purpose: "quote" }, { id: "a", text: "y", purpose: "quote" }]));
  assert.throws(() => validateQuestions([{ id: "a", text: "x", purpose: "whenever" }]));
});
