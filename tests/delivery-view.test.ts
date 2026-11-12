/**
 * The customer delivery boundary: a tenant-scoped, authorization-checked view; downloads limited to
 * the files the approval packet lists; acceptance and correction bound to the delivered digest; a
 * correction recorded beside the delivery, never changing it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { digest } from "../src/canonical.js";
import { sha256Hex } from "../src/deliverables.js";
import { delivered, newOrg, raw, rejectsWith, withApp } from "./_harness.js";

test("the customer view: status, deliverables, criteria, evidence, correction deadline and unresolved items, and nothing internal", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const other = await newOrg(t, "Globex", { owner: "gus", member: "gia" });
    const d = await delivered(org);

    const view = (await org.member.query(api.delivery.view, { orderId: d.orderId }))!;
    assert.equal(view.order.status, "delivered");
    assert.equal(view.order.contract, "svc_bill_review_payable_prep@1.0.0");
    assert.equal(view.delivery!.packetDigest, d.packetDigest);
    assert.deepEqual(view.delivery!.files.map((f) => f.name), ["approval-packet.json", "bill-review-results.csv", "bill-review-results.json", "evidence.json", "exceptions.csv", "exceptions.json", "missing-information-requests.json", "payable-recommendation.csv", "payable-recommendation.json", "source-document-references.json", "summary.csv"]);
    assert.deepEqual(Object.keys(view.delivery!.acceptanceCriteria), ["completeness", "traceability", "recomputation", "classification", "no_accounting_mutation", "package_integrity", "reviewed", "on_time"]);
    assert.ok(Object.values(view.delivery!.acceptanceCriteria).every((c) => c === "passed"));
    assert.equal(view.delivery!.evidence.file, "evidence.json");
    assert.equal(view.delivery!.evidence.snapshotDigest.startsWith("sha256:"), true);
    assert.ok(view.delivery!.correctionWindowEndsAt > view.delivery!.publishedAt);
    assert.deepEqual(view.unresolved.customerDecisions.sort(), ["B6:duplicate_in_set", "B7:duplicate_in_set", "B8:duplicate_of_prior"]);
    assert.deepEqual(view.unresolved.informationRequests.filter((r) => r.blocking).map((r) => r.id).sort(), ["B10:request:vendor_unknown", "B9:request:malformed_bill"]);
    // Nothing internal: no operator identities, approval records, run output or other tenants.
    const text = JSON.stringify(view);
    for (const internal of ["otto", "olga", "publishedBy", "approvedBy", "requestedBy", "approvalId", "\"output\"", other.id]) assert.ok(!text.includes(internal), `the view does not expose ${internal}`);

    // A decided duplicate is no longer unresolved.
    await org.member.mutation(api.review.decide, { runId: d.runId, exceptionId: "B6:duplicate_in_set", decision: "confirmed" });
    assert.ok(!(await org.member.query(api.delivery.view, { orderId: d.orderId }))!.unresolved.customerDecisions.includes("B6:duplicate_in_set"));

    // Tenant-scoped and authorization-checked.
    assert.equal(await other.owner.query(api.delivery.view, { orderId: d.orderId }), null);
    await rejectsWith(org.stranger.query(api.delivery.view, { orderId: d.orderId }), "FORBIDDEN"); // not a member: no permission
  }));

test("downloads: exactly the files the approval packet lists, each matching its sha256", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const other = await newOrg(t, "Globex", { owner: "gus", member: "gia" });
    const d = await delivered(org);
    const packet = JSON.parse((await org.owner.query(api.delivery.download, { deliveryId: d.deliveryId, name: "approval-packet.json" })).content);
    assert.equal(digest(packet), d.packetDigest);
    for (const f of packet.files as Array<{ name: string; sha256: string }>) {
      const file = await org.member.query(api.delivery.download, { deliveryId: d.deliveryId, name: f.name });
      assert.equal(sha256Hex(file.content), f.sha256, f.name);
      assert.equal(file.sha256, f.sha256);
    }
    for (const name of ["notes.txt", "../app.ts", "output.json", ""]) await rejectsWith(org.owner.query(api.delivery.download, { deliveryId: d.deliveryId, name }), "NOT_FOUND");
    await rejectsWith(other.owner.query(api.delivery.download, { deliveryId: d.deliveryId, name: "summary.csv" }), "NOT_FOUND");
    await rejectsWith(org.stranger.query(api.delivery.download, { deliveryId: d.deliveryId, name: "summary.csv" }), "FORBIDDEN");
  }));

test("acceptance and correction are bound to the delivered package digest", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const d = await delivered(org);
    const wrong = `sha256:${"0".repeat(64)}`;
    await rejectsWith(org.owner.mutation(api.delivery.accept, { deliveryId: d.deliveryId, packetDigest: wrong, scope: "full" }), "FAILED_PRECONDITION", "DIGEST_MISMATCH");
    await rejectsWith(org.owner.mutation(api.delivery.requestCorrection, { deliveryId: d.deliveryId, packetDigest: wrong, reason: "x" }), "FAILED_PRECONDITION", "DIGEST_MISMATCH");
    const partial = await org.owner.mutation(api.delivery.accept, { deliveryId: d.deliveryId, packetDigest: d.packetDigest, scope: "partial", acceptedBills: ["B1", "B11"] });
    assert.deepEqual([partial.billsCounted, partial.chargeMinor], [2, 25_000]);
    const view = (await org.owner.query(api.delivery.view, { orderId: d.orderId }))!;
    assert.deepEqual([view.order.status, view.delivery!.acceptance!.scope, view.delivery!.acceptance!.acceptedBills], ["delivery_accepted", "partial", ["B1", "B11"]]);
  }));

test("a correction is a durable record beside the delivery, within the window only, and never changes the delivery", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const d = await delivered(org);
    const before = digest((await raw(t, "deliveries").find({}))[0]);
    await org.owner.mutation(api.delivery.requestCorrection, { deliveryId: d.deliveryId, packetDigest: d.packetDigest, reason: "B3's total was mistyped." });
    assert.equal(digest((await raw(t, "deliveries").find({}))[0]), before, "the delivery record is unchanged");
    const [correction] = await raw(t, "corrections").find({});
    assert.deepEqual([correction!.deliveryId, correction!.requestedBy, correction!.reason], [d.deliveryId, "ada", "B3's total was mistyped."]);
    const view = (await org.owner.query(api.delivery.view, { orderId: d.orderId }))!;
    assert.deepEqual([view.order.status, view.delivery!.correction!.reason], ["correcting", "B3's total was mistyped."]);

    const late = await newOrg(t, "Initech", { owner: "ian", member: "ivy" });
    const d2 = await delivered(late);
    await raw(t, "deliveries").update(d2.deliveryId, { correctionWindowEndsAt: Date.now() - 1 });
    await rejectsWith(late.owner.mutation(api.delivery.requestCorrection, { deliveryId: d2.deliveryId, packetDigest: d2.packetDigest, reason: "too late" }), "FAILED_PRECONDITION", "WINDOW_CLOSED");
    assert.equal((await raw(t, "corrections").find({})).length, 1);
  }));
