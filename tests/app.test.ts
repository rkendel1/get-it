/**
 * get-it on a real FeltKit runtime (fresh FeltDB per test).
 *
 * Covers: in-store tenant isolation with explicit tenantId; idempotent re-import of the same bill
 * set; approval refusals; refusal of every accounting mutation and the function inventory; integrity
 * checks over edited inputs, outputs and approvals; publication, acceptance (full and partial),
 * correction; and the business-day clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { ACCOUNTING_ACTIONS } from "../src/accounting.js";
import { digest } from "../src/canonical.js";
import { billSet } from "./_bills.js";
import { delivered, newOrg, ordered, raw, rejectsWith, reviewed, withApp } from "./_harness.js";

test("tenant isolation: another organization's records do not exist for the caller, and every record carries an explicit tenantId", () =>
  withApp(async (t) => {
    // The same operators work in both organizations; only the session's tenant differs.
    const acme = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const globex = await newOrg(t, "Globex", { owner: "gus", member: "gia" });
    const a = await delivered(acme);

    assert.equal((await acme.operator.query(api.orders.list, {})).length, 1);
    assert.deepEqual(await globex.operator.query(api.orders.list, {}), []);
    assert.equal(await globex.operator.query(api.orders.get, { id: a.orderId }), null);
    assert.equal(await globex.operator.query(api.runs.get, { id: a.runId }), null);
    assert.equal(await globex.owner.query(api.delivery.get, { id: a.deliveryId }), null);
    assert.equal(await globex.owner.query(api.delivery.files, { deliveryId: a.deliveryId }), null);
    assert.deepEqual(await globex.operator.query(api.imports.list, { orderId: a.orderId }), []);
    await rejectsWith(globex.operator.mutation(api.imports.record, { orderId: a.orderId, billSet: billSet() }), "NOT_FOUND");
    await rejectsWith(globex.operator.mutation(api.runs.reviewSnapshot, { snapshotId: a.snapshotId }), "NOT_FOUND");
    await rejectsWith(globex.reviewer.mutation(api.review.approve, { packetId: a.packetId, digest: a.packetDigest }), "NOT_FOUND");
    await rejectsWith(globex.owner.mutation(api.review.decide, { runId: a.runId, exceptionId: "B6:duplicate_in_set", decision: "confirmed" }), "NOT_FOUND");
    await rejectsWith(globex.owner.mutation(api.delivery.accept, { deliveryId: a.deliveryId, packetDigest: a.packetDigest, scope: "full" }), "NOT_FOUND");
    await rejectsWith(globex.operator.mutation(api.orders.block, { orderId: a.orderId, reason: "x" }), "NOT_FOUND");

    for (const name of ["orders", "sourceRecords", "snapshots", "runs", "packets", "approvals", "deliveries"]) {
      const rows = await raw(t, name).find({});
      assert.ok(rows.length > 0, name);
      assert.ok(rows.every((r) => r.tenantId === acme.id), `${name}: every record has tenantId = Acme`);
    }
    assert.deepEqual((await globex.operator.query(api.integrity.check, {})).problems, []);
    assert.deepEqual((await acme.operator.query(api.integrity.check, {})).problems, []);
  }));

test("idempotent re-import: the same bill set is one snapshot; a changed bill adds only itself", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const o = await ordered(org);
    const orderId = o.orderId;
    const set = billSet();
    // The order's first snapshot came from intake; importing the same set again writes nothing.
    const first = await org.operator.mutation(api.imports.record, { orderId, billSet: set });
    assert.deepEqual([first.status, first.snapshotId, first.recordsAdded], ["duplicate", o.snapshotId, 0]);
    assert.equal((await raw(t, "sourceRecords").find({})).length, 18); // 11 bills + 3 vendors + 3 accounts + 1 prior bill

    const shuffled = { ...set, bills: [...set.bills].reverse(), vendors: [...set.vendors].reverse() };
    const again = await org.operator.mutation(api.imports.record, { orderId, billSet: shuffled });
    assert.deepEqual([again.status, again.snapshotId, again.digest, again.recordsAdded], ["duplicate", first.snapshotId, first.digest, 0]);
    assert.equal((await raw(t, "sourceRecords").find({})).length, 18);
    assert.equal((await raw(t, "snapshots").find({})).length, 1);

    const corrected = { ...set, bills: set.bills.map((b) => (b.id === "B3" ? { ...b, totalMinor: 7500 } : b)) };
    const changed = await org.operator.mutation(api.imports.record, { orderId, billSet: corrected });
    assert.deepEqual([changed.status, changed.recordsAdded], ["recorded", 1]);
    assert.equal((await raw(t, "sourceRecords").find({ key: "B3" })).length, 2, "the earlier version is kept");

    const r1 = await org.operator.mutation(api.runs.reviewSnapshot, { snapshotId: first.snapshotId });
    const r2 = await org.operator.mutation(api.runs.reviewSnapshot, { snapshotId: first.snapshotId });
    assert.deepEqual([r1.status, r2.status, r2.runId, r2.outputDigest], ["recorded", "duplicate", r1.runId, r1.outputDigest]);

    // Invalid reference data refuses the whole set, listing the issues; nothing is written.
    await rejectsWith(org.operator.mutation(api.imports.record, { orderId, billSet: { ...set, vendors: [{ id: "V1", name: "x" }] } }), "INVALID_ARGUMENT", "BILL_SET_INVALID");
    assert.equal((await raw(t, "snapshots").find({})).length, 2);
    await rejectsWith(org.owner.mutation(api.imports.record, { orderId, billSet: set }), "FORBIDDEN");
  }));

test("approvals are refused for agents, customers without authority, expired requests, wrong digests and the requester", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const r = await reviewed(org);
    const { packetId, digest } = await org.operator.mutation(api.review.request, { runId: r.runId });
    assert.equal(digest, r.packetDigest);

    await rejectsWith(org.agent.mutation(api.review.approve, { packetId, digest }), "FORBIDDEN", "NOT_A_PERSON");
    await rejectsWith(org.owner.mutation(api.review.approve, { packetId, digest }), "FORBIDDEN");
    await rejectsWith(org.member.mutation(api.review.approve, { packetId, digest }), "FORBIDDEN");
    await rejectsWith(org.operator.mutation(api.review.approve, { packetId, digest }), "FORBIDDEN", "SELF_APPROVAL");
    await rejectsWith(org.reviewer.mutation(api.review.approve, { packetId, digest: `sha256:${"0".repeat(64)}` }), "FAILED_PRECONDITION", "DIGEST_MISMATCH");
    await rejectsWith(org.operator.mutation(api.delivery.publish, { packetId }), "FAILED_PRECONDITION", "NOT_APPROVED");

    await raw(t, "packets").update(packetId, { expiresAt: Date.now() - 1 });
    await rejectsWith(org.reviewer.mutation(api.review.approve, { packetId, digest }), "FAILED_PRECONDITION", "EXPIRED");

    // A fresh request after expiry can be approved, once, by another person.
    const again = await org.operator.mutation(api.review.request, { runId: r.runId });
    assert.notEqual(again.packetId, packetId);
    assert.equal((await org.reviewer.mutation(api.review.approve, { packetId: again.packetId, digest })).status, "approved");
    assert.equal((await org.reviewer.mutation(api.review.approve, { packetId: again.packetId, digest })).status, "existing");
    const [approval] = await org.operator.query(api.review.listApprovals, { packetId: again.packetId });
    assert.deepEqual([approval!.approvedBy, approval!.requestedBy, approval!.approverType], ["olga", "otto", "user"]);
  }));

test("customer decisions: suspected duplicates only, by the customer's people, once", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const r = await reviewed(org);
    await rejectsWith(org.operator.mutation(api.review.decide, { runId: r.runId, exceptionId: "B6:duplicate_in_set", decision: "confirmed" }), "FORBIDDEN");
    await rejectsWith(org.member.mutation(api.review.decide, { runId: r.runId, exceptionId: "B3:total_mismatch", decision: "acknowledged" }), "FAILED_PRECONDITION");
    await org.member.mutation(api.review.decide, { runId: r.runId, exceptionId: "B6:duplicate_in_set", decision: "confirmed", note: "Entered twice." });
    await rejectsWith(org.owner.mutation(api.review.decide, { runId: r.runId, exceptionId: "B6:duplicate_in_set", decision: "rejected" }), "CONFLICT");
    assert.deepEqual((await org.operator.query(api.integrity.check, {})).problems, []);
  }));

test("every accounting mutation is refused, for every role, and the app has no other functions", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    for (const caller of [org.owner, org.member, org.operator, org.agent]) {
      for (const action of ACCOUNTING_ACTIONS) await rejectsWith(caller.mutation(api.accounting.request, { action, billKey: "B1" }), "FORBIDDEN", "ACCOUNTING_MUTATION_REFUSED");
    }
    // The function inventory is fixed: a new function (say, one that posts a bill) is a reviewed change.
    const functions = [...t.runtime.project.functions.keys()].sort();
    assert.deepEqual(functions, [
      "accounting:request",
      "delivery:accept", "delivery:download", "delivery:files", "delivery:get", "delivery:publish", "delivery:requestCorrection", "delivery:view",
      "imports:list", "imports:record",
      "intake:answer", "intake:complete", "intake:create", "intake:get", "intake:list", "intake:uploadBillSet",
      "integrity:check",
      "orders:acceptForFulfillment", "orders:block", "orders:clock", "orders:get", "orders:list", "orders:unblock",
      "payments:record",
      "quotes:accept", "quotes:create", "quotes:get",
      "review:approve", "review:decide", "review:listApprovals", "review:listPackets", "review:request",
      "runs:get", "runs:reviewSnapshot",
    ]);
    // None of them is an accounting action under another name: payments:record records the customer's payment to get-it.
    const accountingNames = new Set(ACCOUNTING_ACTIONS.map((a) => a.replace(".", ":")));
    assert.deepEqual(functions.filter((f) => accountingNames.has(f)), []);
    // A full review leaves every submitted record exactly as submitted.
    const d = await delivered(org);
    for (const r of await raw(t, "sourceRecords").find({})) assert.equal(digest(r.record), r.digest);
    const files = (await org.owner.query(api.delivery.files, { deliveryId: d.deliveryId }))!;
    assert.ok(JSON.parse(files["payable-recommendation.json"]!).every((r: { advisory: boolean }) => r.advisory === true));
  }));

test("integrity: recomputation catches edited inputs, outputs and approvals", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const d = await delivered(org);
    const clean = await org.operator.query(api.integrity.check, {});
    assert.deepEqual(clean.problems, []);
    assert.equal(clean.counts.deliveries, 1);

    const [input] = await raw(t, "sourceRecords").find({ key: "B1" });
    await raw(t, "sourceRecords").update(input!.id, { record: { ...input!.record, totalMinor: 1 } });
    const [run] = await raw(t, "runs").find({});
    const output = { ...run!.output, summary: { ...run!.output.summary, bills: 99 } };
    await raw(t, "runs").update(run!.id, { output, outputDigest: digest(output) }); // digest "fixed up" to match
    const [approval] = await raw(t, "approvals").find({});
    await raw(t, "approvals").update(approval!.id, { approvedBy: "otto" });

    const problems = (await org.operator.query(api.integrity.check, {})).problems.join("\n");
    assert.match(problems, /input bill B1: content does not match its digest/);
    assert.match(problems, new RegExp(`run ${run!.id}: packet digest does not recompute`));
    assert.match(problems, new RegExp(`run ${run!.id}: output does not recompute from its snapshot`));
    assert.match(problems, new RegExp(`approval ${approval!.id}: approved by its requester`));
    // The edited output no longer produces the delivered package, so the files are refused.
    await rejectsWith(org.owner.query(api.delivery.files, { deliveryId: d.deliveryId }), "FAILED_PRECONDITION", "STALE");
  }));

test("acceptance: in full by the customer owner, partial by named bills, charged by the contract", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const d = await delivered(org);
    assert.equal(d.onTime, true);
    await rejectsWith(org.member.mutation(api.delivery.accept, { deliveryId: d.deliveryId, packetDigest: d.packetDigest, scope: "full" }), "FORBIDDEN");
    await rejectsWith(org.operator.mutation(api.delivery.accept, { deliveryId: d.deliveryId, packetDigest: d.packetDigest, scope: "full" }), "FORBIDDEN");
    await rejectsWith(org.owner.mutation(api.delivery.accept, { deliveryId: d.deliveryId, packetDigest: d.packetDigest, scope: "partial", acceptedBills: [] }), "INVALID_ARGUMENT");
    await rejectsWith(org.owner.mutation(api.delivery.accept, { deliveryId: d.deliveryId, packetDigest: d.packetDigest, scope: "partial", acceptedBills: ["B1", "B404"] }), "INVALID_ARGUMENT");

    const partial = await org.owner.mutation(api.delivery.accept, { deliveryId: d.deliveryId, packetDigest: d.packetDigest, scope: "partial", acceptedBills: ["B1", "B11", "B2"] });
    assert.deepEqual([partial.billsCounted, partial.chargeMinor], [3, 25_000]);
    await rejectsWith(org.owner.mutation(api.delivery.accept, { deliveryId: d.deliveryId, packetDigest: d.packetDigest, scope: "full" }), "CONFLICT", "ALREADY_ACCEPTED");
    await rejectsWith(org.owner.mutation(api.delivery.requestCorrection, { deliveryId: d.deliveryId, packetDigest: d.packetDigest, reason: "late change" }), "CONFLICT", "ALREADY_ACCEPTED");
    assert.equal((await org.owner.query(api.orders.get, { id: d.orderId }))!.status, "delivery_accepted");
    assert.deepEqual((await org.operator.query(api.integrity.check, {})).problems, []);

    const other = await newOrg(t, "Initech", { owner: "ian", member: "ivy" });
    const full = await delivered(other);
    assert.deepEqual(await other.owner.mutation(api.delivery.accept, { deliveryId: full.deliveryId, packetDigest: full.packetDigest, scope: "full" }).then((x) => [x.billsCounted, x.chargeMinor]), [11, 25_000]);
  }));

test("correction: within the window and before acceptance; the corrected package needs a new approval", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const d = await delivered(org);
    await rejectsWith(org.member.mutation(api.delivery.requestCorrection, { deliveryId: d.deliveryId, packetDigest: d.packetDigest, reason: "B3 total" }), "FORBIDDEN");
    await org.owner.mutation(api.delivery.requestCorrection, { deliveryId: d.deliveryId, packetDigest: d.packetDigest, reason: "B3's total was mistyped; corrected bill attached." });
    assert.equal((await org.owner.query(api.orders.get, { id: d.orderId }))!.status, "correcting");
    await rejectsWith(org.owner.mutation(api.delivery.accept, { deliveryId: d.deliveryId, packetDigest: d.packetDigest, scope: "full" }), "FAILED_PRECONDITION", "CORRECTION_REQUESTED");

    // The customer supplies a corrected bill; the re-review is a new run, packet, approval and delivery.
    const set = billSet();
    const corrected = { ...set, bills: set.bills.map((b) => (b.id === "B3" ? { ...b, totalMinor: 7500 } : b)) };
    const imported = await org.operator.mutation(api.imports.record, { orderId: d.orderId, billSet: corrected });
    const run2 = await org.operator.mutation(api.runs.reviewSnapshot, { snapshotId: imported.snapshotId });
    const output = (await org.operator.query(api.runs.get, { id: run2.runId }))!.output as { results: Array<{ billKey: string; status: string }> };
    assert.equal(output.results.find((r) => r.billKey === "B3")!.status, "ready_for_payable_approval");
    const p2 = await org.operator.mutation(api.review.request, { runId: run2.runId });
    assert.notEqual(p2.digest, d.packetDigest);
    await rejectsWith(org.operator.mutation(api.delivery.publish, { packetId: p2.packetId }), "FAILED_PRECONDITION", "NOT_APPROVED");
    await org.reviewer.mutation(api.review.approve, { packetId: p2.packetId, digest: p2.digest });
    const d2 = await org.operator.mutation(api.delivery.publish, { packetId: p2.packetId });
    assert.equal((await org.owner.mutation(api.delivery.accept, { deliveryId: d2.deliveryId, packetDigest: p2.digest, scope: "full" })).chargeMinor, 25_000);

    // After the window closes, a correction is refused.
    const other = await newOrg(t, "Initech", { owner: "ian", member: "ivy" });
    const late = await delivered(other);
    await raw(t, "deliveries").update(late.deliveryId, { correctionWindowEndsAt: Date.now() - 1 });
    await rejectsWith(other.owner.mutation(api.delivery.requestCorrection, { deliveryId: late.deliveryId, packetDigest: late.packetDigest, reason: "too late" }), "FAILED_PRECONDITION", "WINDOW_CLOSED");
  }));

test("business-day clock: it starts at fulfillment acceptance, blocking pauses it, and lateness is recorded", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const o = await ordered(org);
    const orderId = o.orderId;
    const order = (await org.owner.query(api.orders.get, { id: orderId }))!;
    const [acceptance] = await raw(t, "fulfillmentAcceptances").find({});
    assert.equal(order.clockStartedAt, acceptance!.acceptedAt);
    const clock = (await org.owner.query(api.orders.clock, { id: orderId }))!;
    assert.equal(clock.paused, false);
    assert.ok(clock.deadline! > Date.now());

    await org.operator.mutation(api.orders.block, { orderId, reason: "waiting for the B10 vendor record" });
    await rejectsWith(org.operator.mutation(api.orders.block, { orderId, reason: "again" }), "FAILED_PRECONDITION");
    const blocked = (await org.owner.query(api.orders.clock, { id: orderId }))!;
    assert.deepEqual([blocked.paused, blocked.deadline], [true, null]);

    const run = await org.operator.mutation(api.runs.reviewSnapshot, { snapshotId: o.snapshotId });
    const { packetId, digest: d } = await org.operator.mutation(api.review.request, { runId: run.runId });
    await org.reviewer.mutation(api.review.approve, { packetId, digest: d });
    await rejectsWith(org.operator.mutation(api.delivery.publish, { packetId }), "FAILED_PRECONDITION", "BLOCKED");
    await org.operator.mutation(api.orders.unblock, { orderId, reason: "vendor record received" });

    // Accepted for fulfillment three weeks ago: the deadline has passed. The package is delivered and recorded as late.
    await raw(t, "orders").update(orderId, { clockStartedAt: Date.now() - 21 * 86_400_000 });
    const published = await org.operator.mutation(api.delivery.publish, { packetId });
    assert.equal(published.onTime, false);
    const delivery = (await org.owner.query(api.delivery.get, { id: published.deliveryId }))!.delivery;
    assert.ok(delivery.deadline < delivery.publishedAt);
    assert.deepEqual((delivery.report as { on_time: string[] }).on_time.length, 1);
    assert.ok(delivery.correctionWindowEndsAt > delivery.publishedAt);
    // Moving the clock is itself drift, and the integrity check reports exactly that.
    const problems = (await org.operator.query(api.integrity.check, {})).problems;
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, new RegExp(`order ${orderId}: clock started at \\d+, fulfillment was accepted at ${acceptance!.acceptedAt}`));
  }));
