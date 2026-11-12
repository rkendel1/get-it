/**
 * Intake, quoting, operator-recorded payment and acceptance for fulfillment, on a real FeltKit
 * runtime. The commercial path creates the order; only explicit fulfillment acceptance starts the
 * clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { digest } from "../src/canonical.js";
import { loadFrozenContract } from "../src/contract.js";
import { runPriceMinor } from "../src/pricing.js";
import { quoteTerms } from "../feltkit/quotes.js";
import { bill, billSet } from "./_bills.js";
import { ANSWERS, intake, newOrg, raw, rejectsWith, withApp } from "./_harness.js";

const contract = loadFrozenContract();

test("intake answers: out of range, wrong type, unknown field, bill-set field, declined required, and another tenant's session are refused", () =>
  withApp(async (t) => {
    const acme = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const globex = await newOrg(t, "Globex", { owner: "gus", member: "gia" });
    const { sessionId } = await acme.owner.mutation(api.intake.create, { request: "Review our bills." });
    const answer = (field: string, value?: unknown, decline?: boolean) => acme.member.mutation(api.intake.answer, { sessionId, field, ...(value !== undefined ? { value } : {}), ...(decline ? { decline } : {}) });

    await rejectsWith(answer("policy.dueSoonBusinessDays", 31), "INVALID_ARGUMENT", "ANSWER_INVALID");
    await rejectsWith(answer("policy.documentRequiredOverMinor", -1), "INVALID_ARGUMENT", "ANSWER_INVALID");
    await rejectsWith(answer("policy.documentRequiredOverMinor", "7500"), "INVALID_ARGUMENT", "ANSWER_INVALID");
    await rejectsWith(answer("timeZone", "Mars/Olympus"), "INVALID_ARGUMENT", "ANSWER_INVALID");
    await rejectsWith(answer("homeCurrency", 840), "INVALID_ARGUMENT", "ANSWER_INVALID");
    await rejectsWith(answer("discountPercent", 10), "INVALID_ARGUMENT", "UNKNOWN_INPUT");
    await rejectsWith(answer("bills", []), "INVALID_ARGUMENT", "BILL_SET_INPUT");
    await rejectsWith(answer("asOfDate", undefined, true), "INVALID_ARGUMENT", "REQUIRED_INPUT");
    await rejectsWith(answer("asOfDate"), "INVALID_ARGUMENT", "ANSWER_INVALID");
    await rejectsWith(globex.owner.mutation(api.intake.answer, { sessionId, field: "asOfDate", value: "2026-11-10" }), "NOT_FOUND");
    await rejectsWith(globex.owner.query(api.intake.get, { sessionId }).then((x) => (x === null ? Promise.reject({ code: "NOT_FOUND" }) : x)), "NOT_FOUND");
    await rejectsWith(acme.stranger.mutation(api.intake.answer, { sessionId, field: "asOfDate", value: "2026-11-10" }), "FORBIDDEN"); // not a member: no permission

    // Valid answers are recorded; the latest answer for a field wins; nothing was recorded for the refusals.
    await answer("asOfDate", "2026-11-09");
    await answer("asOfDate", "2026-11-10");
    const view = (await acme.owner.query(api.intake.get, { sessionId }))!;
    assert.deepEqual(view.answers, { asOfDate: { kind: "answer", value: "2026-11-10" } });
    assert.equal((await raw(t, "intakeAnswers").find({})).length, 2);
    assert.ok((await raw(t, "intakeAnswers").find({})).every((r) => r.tenantId === acme.id));
  }));

test("uploading the same bill set twice is idempotent; a changed set supersedes it", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const { sessionId } = await org.owner.mutation(api.intake.create, { request: "Review our bills." });
    const set = billSet();
    const first = await org.owner.mutation(api.intake.uploadBillSet, { sessionId, billSet: set });
    assert.deepEqual([first.status, first.bills, first.recordsAdded], ["bound", 11, 18]);
    const again = await org.owner.mutation(api.intake.uploadBillSet, { sessionId, billSet: { ...set, bills: [...set.bills].reverse() } });
    assert.deepEqual([again.status, again.bindingId, again.digest, again.recordsAdded], ["duplicate", first.bindingId, first.digest, 0]);
    assert.equal((await raw(t, "inputBindings").find({})).length, 1);
    assert.equal((await raw(t, "sourceRecords").find({})).length, 18);

    const changed = await org.owner.mutation(api.intake.uploadBillSet, { sessionId, billSet: { ...set, bills: set.bills.slice(0, 5) } });
    assert.deepEqual([changed.status, changed.bills, changed.recordsAdded], ["bound", 5, 0]);
    assert.equal((await org.owner.query(api.intake.get, { sessionId }))!.billSet!.digest, changed.digest, "the latest upload is bound");
    // The same validator as import: invalid reference data is refused with every issue.
    await rejectsWith(org.owner.mutation(api.intake.uploadBillSet, { sessionId, billSet: { ...set, vendors: [{ id: "V1" }] } }), "INVALID_ARGUMENT", "BILL_SET_INVALID");
  }));

test("intake cannot complete with required inputs missing; completion records assumptions, the contract and a deterministic report", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    // The bill set alone is not enough: the required answers are missing, and each is named.
    const { sessionId: early } = await org.owner.mutation(api.intake.create, { request: "Review our bills." });
    await org.owner.mutation(api.intake.uploadBillSet, { sessionId: early, billSet: billSet() });
    await assert.rejects(org.owner.mutation(api.intake.complete, { sessionId: early }), (e: any) => {
      assert.equal(e.code, "FAILED_PRECONDITION");
      assert.deepEqual(e.details?.missing ?? e.missing, ["homeCurrency", "timeZone", "asOfDate"]);
      return true;
    });
    assert.equal((await raw(t, "intakeCompleteness").find({})).length, 0);

    const { sessionId } = await org.owner.mutation(api.intake.create, { request: "Review our bills." });
    await org.owner.mutation(api.intake.answer, { sessionId, field: "homeCurrency", value: "USD" });
    await rejectsWith(org.owner.mutation(api.intake.complete, { sessionId }), "FAILED_PRECONDITION", "INTAKE_INCOMPLETE");
    await org.owner.mutation(api.intake.answer, { sessionId, field: "timeZone", value: ANSWERS.timeZone });
    await org.owner.mutation(api.intake.answer, { sessionId, field: "asOfDate", value: ANSWERS.asOfDate });
    await rejectsWith(org.owner.mutation(api.intake.complete, { sessionId }), "FAILED_PRECONDITION", "INTAKE_INCOMPLETE");
    await org.owner.mutation(api.intake.uploadBillSet, { sessionId, billSet: { ...billSet(), priorBills: undefined } });
    await org.owner.mutation(api.intake.answer, { sessionId, field: "policy.dueSoonBusinessDays", decline: true });

    const done = await org.owner.mutation(api.intake.complete, { sessionId });
    assert.equal(done.status, "complete");
    const record = (await raw(t, "intakeCompleteness").find({}))[0]!;
    assert.deepEqual([record.contract, record.contractDigest], [contract.key, contract.digest]);
    assert.deepEqual(record.assumptions.map((a: { input: string; how: string }) => [a.input, a.how]), [
      ["policy.documentRequiredOverMinor", "not_answered"],
      ["policy.dueSoonBusinessDays", "declined"],
      ["priorBills", "not_supplied"],
    ]);
    assert.equal(record.reportDigest, digest(record.report));
    // Completion is idempotent, closes the intake, and creates no order and no clock.
    assert.equal((await org.owner.mutation(api.intake.complete, { sessionId })).completenessId, done.completenessId);
    await rejectsWith(org.owner.mutation(api.intake.answer, { sessionId, field: "asOfDate", value: "2026-11-11" }), "FAILED_PRECONDITION", "INTAKE_CLOSED");
    await rejectsWith(org.owner.mutation(api.intake.uploadBillSet, { sessionId, billSet: billSet() }), "FAILED_PRECONDITION", "INTAKE_CLOSED");
    assert.deepEqual(await org.owner.query(api.orders.list, {}), []);

    // The same answers and set in another organization give the same report digest.
    const other = await newOrg(t, "Globex", { owner: "gus", member: "gia" });
    const s2 = (await other.owner.mutation(api.intake.create, { request: "Different words." })).sessionId;
    await other.owner.mutation(api.intake.uploadBillSet, { sessionId: s2, billSet: { ...billSet(), priorBills: undefined } });
    for (const [field, value] of Object.entries(ANSWERS).reverse()) await other.owner.mutation(api.intake.answer, { sessionId: s2, field, value });
    await other.owner.mutation(api.intake.answer, { sessionId: s2, field: "policy.dueSoonBusinessDays", decline: true });
    await other.owner.mutation(api.intake.complete, { sessionId: s2 });
    const record2 = (await raw(t, "intakeCompleteness").find({})).find((r) => r.tenantId === other.id)!;
    assert.equal(record2.reportDigest, record.reportDigest);
  }));

test("quotes: require a complete intake, equal runPriceMinor, record their terms, and are immutable", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const { sessionId: open } = await org.owner.mutation(api.intake.create, { request: "Review our bills." });
    await rejectsWith(org.operator.mutation(api.quotes.create, { sessionId: open }), "FAILED_PRECONDITION", "INTAKE_INCOMPLETE");

    // 130 bills: $250 + 30 × $2 = $310.
    const many = { ...billSet(), priorBills: undefined, bills: Array.from({ length: 130 }, (_, i) => bill({ id: `M${i}`, vendorId: "V1", billNumber: `M-${i}`, billDate: "2026-11-02", dueDate: "2026-12-02", lines: [{ accountId: "6000", amountMinor: 100 + i }] })) };
    const { sessionId } = await intake(org, many);
    await rejectsWith(org.owner.mutation(api.quotes.create, { sessionId }), "FORBIDDEN");
    const q = await org.operator.mutation(api.quotes.create, { sessionId });
    assert.deepEqual([q.billCount, q.priceMinor, q.currency], [130, runPriceMinor(130, contract.pricing), "USD"]);
    assert.equal(q.priceMinor, 31_000);
    const quote = (await org.owner.query(api.quotes.get, { id: q.quoteId }))!;
    assert.deepEqual([quote.contract, quote.contractDigest, quote.turnaroundBusinessDays], [contract.key, contract.digest, 2]);
    assert.deepEqual(quote.assumptions.map((a: { input: string }) => a.input), ["policy.documentRequiredOverMinor", "policy.dueSoonBusinessDays", "priorBills"]);
    assert.ok(quote.validUntil > quote.createdAt);

    // Immutable: a second create returns the same quote; no function changes it; drift is detected.
    const again = await org.operator.mutation(api.quotes.create, { sessionId });
    assert.deepEqual([again.quoteId, again.quoteDigest, again.status], [q.quoteId, q.quoteDigest, "existing"]);
    assert.deepEqual((await org.operator.query(api.integrity.check, {})).problems, []);
    await raw(t, "quotes").update(q.quoteId, { priceMinor: 1 });
    const problems = (await org.operator.query(api.integrity.check, {})).problems.join("\n");
    assert.match(problems, new RegExp(`quote ${q.quoteId}: content does not match its digest`));
    assert.match(problems, new RegExp(`quote ${q.quoteId}: price 1 is not runPriceMinor\\(130\\) = 31000`));
    await raw(t, "quotes").update(q.quoteId, { priceMinor: 31_000, assumptions: [] });
    assert.deepEqual((await org.operator.query(api.integrity.check, {})).problems, [`quote ${q.quoteId}: content does not match its digest`], "dropping the assumptions is drift too");
  }));

test("quote acceptance: owner-only, person-only, bound to the quote digest, idempotent, one order, no fulfillment", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const other = await newOrg(t, "Globex", { owner: "gus", member: "gia" });
    const { sessionId } = await intake(org);
    const q = await org.operator.mutation(api.quotes.create, { sessionId });
    const accept = (caller = org.owner, quoteDigest = q.quoteDigest) => caller.mutation(api.quotes.accept, { quoteId: q.quoteId, quoteDigest });

    await rejectsWith(accept(org.member), "FORBIDDEN");
    await rejectsWith(accept(org.operator), "FORBIDDEN");
    await rejectsWith(accept(org.agent), "FORBIDDEN");
    await rejectsWith(accept(other.owner), "NOT_FOUND");
    await rejectsWith(accept(org.owner, `sha256:${"0".repeat(64)}`), "FAILED_PRECONDITION", "DIGEST_MISMATCH");

    const first = await accept();
    const second = await accept();
    assert.deepEqual([second.status, second.acceptanceId, second.orderId], ["existing", first.acceptanceId, first.orderId]);
    assert.equal((await raw(t, "orders").find({})).length, 1);
    assert.equal((await raw(t, "quoteAcceptances").find({})).length, 1);
    const order = (await org.owner.query(api.orders.get, { id: first.orderId }))!;
    assert.deepEqual([order.status, order.clockStartedAt, order.quoteId], ["awaiting_payment", undefined, q.quoteId]);
    assert.deepEqual([order.homeCurrency, order.timeZone, order.asOfDate, order.policy], ["USD", "America/New_York", "2026-11-10", { documentRequiredOverMinor: 7500, dueSoonBusinessDays: 5 }]);
    assert.equal((await org.owner.query(api.orders.clock, { id: first.orderId }))!.paused, true);

    // An expired quote cannot be accepted. (A quote whose validity was edited in place is refused as tampered.)
    const { sessionId: s2 } = await intake(other);
    const q2 = await other.operator.mutation(api.quotes.create, { sessionId: s2 });
    await raw(t, "quotes").update(q2.quoteId, { validUntil: Date.now() - 1 });
    await rejectsWith(other.owner.mutation(api.quotes.accept, { quoteId: q2.quoteId, quoteDigest: q2.quoteDigest }), "FAILED_PRECONDITION", "STALE");
    // A consistently expired quote (its digest covers the past validity) is refused as expired.
    const [stored] = await raw(t, "quotes").find({ id: q2.quoteId } as never);
    const expired = { ...stored!, validUntil: Date.now() - 1 };
    const expiredDigest = digest(quoteTerms(expired as never));
    await raw(t, "quotes").update(q2.quoteId, { validUntil: expired.validUntil, digest: expiredDigest });
    await rejectsWith(other.owner.mutation(api.quotes.accept, { quoteId: q2.quoteId, quoteDigest: expiredDigest }), "FAILED_PRECONDITION", "QUOTE_EXPIRED");
  }));

test("payment: operator-recorded once per accepted quote, for the quoted amount, enabling the order without starting fulfillment", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const { sessionId } = await intake(org);
    const q = await org.operator.mutation(api.quotes.create, { sessionId });
    const pay = (caller = org.operator, over: Record<string, unknown> = {}) =>
      caller.mutation(api.payments.record, { quoteId: q.quoteId, amountMinor: q.priceMinor, currency: "USD", method: "bank_transfer", reference: "wire-881", idempotencyKey: "pay-1", ...over } as never);

    await rejectsWith(pay(), "FAILED_PRECONDITION", "QUOTE_NOT_ACCEPTED");
    const { orderId } = await org.owner.mutation(api.quotes.accept, { quoteId: q.quoteId, quoteDigest: q.quoteDigest });
    await rejectsWith(pay(org.owner), "FORBIDDEN");
    await rejectsWith(pay(org.agent), "FORBIDDEN", "NOT_A_PERSON");
    await rejectsWith(pay(org.operator, { amountMinor: q.priceMinor - 1 }), "INVALID_ARGUMENT", "AMOUNT_MISMATCH");
    await rejectsWith(pay(org.operator, { currency: "EUR" }), "INVALID_ARGUMENT", "AMOUNT_MISMATCH");

    const first = await pay();
    assert.equal(first.status, "recorded");
    assert.deepEqual(await pay().then((x) => [x.status, x.paymentId]), ["existing", first.paymentId], "the same idempotency key returns the payment");
    await rejectsWith(pay(org.reviewer, { idempotencyKey: "pay-2", reference: "wire-882" }), "CONFLICT", "ALREADY_PAID");
    const [payment] = await raw(t, "payments").find({});
    assert.deepEqual([payment!.amountMinor, payment!.currency, payment!.method, payment!.reference, payment!.recordedBy, payment!.quoteDigest, payment!.idempotencyKey], [q.priceMinor, "USD", "bank_transfer", "wire-881", "otto", q.quoteDigest, "pay-1"]);
    assert.equal(typeof payment!.recordedAt, "number");

    const order = (await org.owner.query(api.orders.get, { id: orderId }))!;
    assert.deepEqual([order.status, order.clockStartedAt], ["paid", undefined], "payment does not imply fulfillment acceptance");
    assert.deepEqual(await org.operator.query(api.imports.list, { orderId }), [], "no bill set is recorded for the order before fulfillment");
    await rejectsWith(org.operator.mutation(api.imports.record, { orderId, billSet: billSet() }), "FAILED_PRECONDITION", "NOT_IN_FULFILLMENT");
  }));

test("fulfillment acceptance: only after payment, by an operator person, and only then does the clock start", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const { sessionId } = await intake(org);
    const q = await org.operator.mutation(api.quotes.create, { sessionId });
    const { orderId } = await org.owner.mutation(api.quotes.accept, { quoteId: q.quoteId, quoteDigest: q.quoteDigest });
    await rejectsWith(org.operator.mutation(api.orders.acceptForFulfillment, { orderId }), "FAILED_PRECONDITION", "NOT_PAID");
    await org.operator.mutation(api.payments.record, { quoteId: q.quoteId, amountMinor: q.priceMinor, currency: "USD", method: "check", reference: "chk-1001", idempotencyKey: "k1" });
    await rejectsWith(org.owner.mutation(api.orders.acceptForFulfillment, { orderId }), "FORBIDDEN");
    await rejectsWith(org.agent.mutation(api.orders.acceptForFulfillment, { orderId }), "FORBIDDEN", "NOT_A_PERSON");
    assert.equal((await org.owner.query(api.orders.clock, { id: orderId }))!.paused, true);

    const before = Date.now();
    const accepted = await org.operator.mutation(api.orders.acceptForFulfillment, { orderId });
    const order = (await org.owner.query(api.orders.get, { id: orderId }))!;
    assert.equal(order.status, "accepted_for_fulfillment");
    assert.ok(order.clockStartedAt! >= before && order.clockStartedAt === accepted.acceptedAt);
    const clock = (await org.owner.query(api.orders.clock, { id: orderId }))!;
    assert.deepEqual([clock.paused, clock.deadline! > order.clockStartedAt!], [false, true]);
    assert.equal((await org.operator.mutation(api.orders.acceptForFulfillment, { orderId })).status, "existing");
    const [record] = await raw(t, "fulfillmentAcceptances").find({});
    assert.deepEqual([record!.contractDigest, record!.acceptedBy, record!.grants], [contract.digest, "otto", []]);
    // The frozen contract: "the turnaround starts when the first complete bill set is recorded for the order".
    assert.match(contract.service.turnaroundStarts, /first complete bill set is recorded for the order/);
    const snapshots = await org.operator.query(api.imports.list, { orderId });
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!.importedAt, order.clockStartedAt, "the bill set is recorded for the order at the moment the clock starts");

    // Blocking still pauses the clock after fulfillment starts.
    await org.operator.mutation(api.orders.block, { orderId, reason: "waiting for a vendor record" });
    assert.equal((await org.owner.query(api.orders.clock, { id: orderId }))!.paused, true);
    await org.operator.mutation(api.orders.unblock, { orderId, reason: "received" });
    assert.equal((await org.owner.query(api.orders.clock, { id: orderId }))!.paused, false);
    assert.deepEqual((await org.operator.query(api.integrity.check, {})).problems, []);
  }));
