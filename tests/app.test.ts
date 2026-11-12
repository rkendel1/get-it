/**
 * get-it on a real FeltKit runtime (fresh FeltDB per test): in-store tenant isolation with explicit
 * tenantId, idempotent QuickBooks imports, person-only digest-bound approvals, customer decisions,
 * and the integrity check catching drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type Caller, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { qboBill, scenario } from "./_qbo.js";

const person = (id: string) => ({ id, type: "user" as const, roles: ["person"] });

interface Org {
  id: string;
  owner: Caller; // customer
  member: Caller; // customer
  operator: Caller; // get-it staff "otto"
  reviewer: Caller; // get-it staff "olga"
  agent: Caller; // an agent holding the operator role
}

async function newOrg(t: TestApp, name: string, ids: { owner: string; member: string; operator?: string; reviewer?: string }): Promise<Org> {
  const tenancy = t.tenancy!;
  const org = await t.provisionTenant(name, { ...person(ids.owner), email: `${ids.owner}@example.com` });
  const ownerCtx = (await tenancy.context(org.id, ids.owner))!;
  const actor = { ...ownerCtx, principalId: ids.owner };
  const join = async (who: string, role: string) => {
    const { token } = await tenancy.invite(actor, { email: `${who}@example.com`, role });
    await tenancy.accept(token, { ...person(who), email: `${who}@example.com`, emailVerified: true });
  };
  const operator = ids.operator ?? "otto";
  const reviewer = ids.reviewer ?? "olga";
  await join(ids.member, "member");
  await join(operator, "operator");
  await join(reviewer, "operator");
  const agentId = `agent-${org.id.slice(-6)}`;
  await tenancy.addPrincipal(actor, { id: agentId, type: "agent", displayName: "Assistant" }, "operator");
  const as = (id: string, type: "user" | "agent" = "user") => t.as({ id, type, roles: type === "user" ? ["person"] : [] }, { tenant: org.id });
  return { id: org.id, owner: as(ids.owner), member: as(ids.member), operator: as(operator), reviewer: as(reviewer), agent: as(agentId, "agent") };
}

async function withApp(fn: (t: TestApp) => Promise<void>) {
  const t = await createTestApp();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

async function rejectsWith(p: Promise<unknown>, code: string, hint?: string) {
  await assert.rejects(p, (e: any) => {
    assert.equal(e.code, code, e.message);
    if (hint) assert.equal(e.hint ?? e.details?.hint, hint, e.message);
    return true;
  });
}

const ORDER = { realmId: "9130", from: "2026-10-01", to: "2026-10-31", timeZone: "America/New_York" };

async function reconciled(org: Org) {
  const orderId = await org.operator.mutation(api.orders.create, ORDER);
  const s = scenario();
  const imported = await org.operator.mutation(api.imports.record, { orderId, bills: s.bills, purchaseOrders: s.purchaseOrders });
  const run = await org.operator.mutation(api.runs.reconcileSnapshot, { snapshotId: imported.snapshotId });
  return { orderId, snapshotId: imported.snapshotId, ...run };
}

/** Read a collection directly from storage, beneath FeltKit's tenant scope. */
const raw = (t: TestApp, name: string) => t.runtime.instance.handle("test.raw").collection<Record<string, any>>(name);

test("tenant isolation: another organization's records do not exist for the caller, and every record carries an explicit tenantId", () =>
  withApp(async (t) => {
    // The same operators work in both organizations; only the session's tenant differs.
    const acme = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const globex = await newOrg(t, "Globex", { owner: "gus", member: "gia" });
    const a = await reconciled(acme);

    assert.equal((await acme.operator.query(api.orders.list, {})).length, 1);
    assert.deepEqual(await globex.operator.query(api.orders.list, {}), []);
    assert.equal(await globex.operator.query(api.orders.get, { id: a.orderId }), null);
    assert.equal(await globex.owner.query(api.runs.get, { id: a.runId }), null);
    assert.deepEqual(await globex.operator.query(api.imports.list, { orderId: a.orderId }), []);
    await rejectsWith(globex.operator.mutation(api.imports.record, { orderId: a.orderId, bills: [], purchaseOrders: [] }), "NOT_FOUND");
    await rejectsWith(globex.operator.mutation(api.runs.reconcileSnapshot, { snapshotId: a.snapshotId }), "NOT_FOUND");
    const { packetId, digest } = await acme.operator.mutation(api.review.request, { runId: a.runId });
    await rejectsWith(globex.reviewer.mutation(api.review.approve, { packetId, digest }), "NOT_FOUND");
    await rejectsWith(globex.owner.mutation(api.review.decide, { runId: a.runId, exceptionId: "5:duplicate_invoice:-", decision: "confirmed" }), "NOT_FOUND");

    // Every stored record names its tenant explicitly, and only Acme's exist.
    for (const name of ["orders", "sourceRecords", "snapshots", "runs", "packets"]) {
      const rows = await raw(t, name).find({});
      assert.ok(rows.length > 0, name);
      assert.ok(rows.every((r) => r.tenantId === acme.id), `${name}: every record has tenantId = Acme`);
    }
    assert.deepEqual((await globex.owner.query(api.integrity.check, {})).problems, []);
    assert.deepEqual((await acme.owner.query(api.integrity.check, {})).problems, []);
  }));

test("idempotent QuickBooks imports: the same content is one snapshot; changed content adds only what changed", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const orderId = await org.operator.mutation(api.orders.create, ORDER);
    const s = scenario();

    const first = await org.operator.mutation(api.imports.record, { orderId, bills: s.bills, purchaseOrders: s.purchaseOrders });
    assert.deepEqual([first.status, first.recordsAdded], ["recorded", 12]); // 8 bills + 4 POs

    // The same pull again, records in a different order: nothing is written.
    const again = await org.operator.mutation(api.imports.record, { orderId, bills: [...s.bills].reverse(), purchaseOrders: [...s.purchaseOrders].reverse() });
    assert.deepEqual([again.status, again.snapshotId, again.digest, again.recordsAdded], ["duplicate", first.snapshotId, first.digest, 0]);
    assert.equal((await raw(t, "sourceRecords").find({})).length, 12);
    assert.equal((await raw(t, "snapshots").find({})).length, 1);

    // A bill edited in QuickBooks: a new snapshot, one new record version; the old version stays.
    const edited = s.bills.map((b) => (b.Id === "4" ? qboBill({ id: "4", vendor: "V3", date: "2026-10-06", doc: "S-1", lines: [{ id: "1", account: true, amount: 810 }] }) : b));
    const changed = await org.operator.mutation(api.imports.record, { orderId, bills: edited, purchaseOrders: s.purchaseOrders });
    assert.deepEqual([changed.status, changed.recordsAdded], ["recorded", 1]);
    assert.notEqual(changed.digest, first.digest);
    assert.equal((await raw(t, "sourceRecords").find({ sourceId: "4", kind: "bill" })).length, 2);

    // Runs are idempotent too: one per (snapshot, contract).
    const r1 = await org.operator.mutation(api.runs.reconcileSnapshot, { snapshotId: first.snapshotId });
    const r2 = await org.operator.mutation(api.runs.reconcileSnapshot, { snapshotId: first.snapshotId });
    assert.deepEqual([r1.status, r2.status, r2.runId, r2.outputDigest], ["recorded", "duplicate", r1.runId, r1.outputDigest]);

    // Out-of-period and malformed records are refused, not skipped.
    await rejectsWith(org.operator.mutation(api.imports.record, { orderId, bills: [qboBill({ id: "77", vendor: "V1", date: "2026-11-02", lines: [{ id: "1", account: true, amount: 5 }] })], purchaseOrders: [] }), "INVALID_ARGUMENT");
    await rejectsWith(org.operator.mutation(api.imports.record, { orderId, bills: [{ Id: "78", VendorRef: { value: "V1" }, TxnDate: "2026-10-02", TotalAmt: 1.001, Line: [] }], purchaseOrders: [] }), "INVALID_ARGUMENT");
    // Customers cannot import.
    await rejectsWith(org.owner.mutation(api.imports.record, { orderId, bills: s.bills, purchaseOrders: s.purchaseOrders }), "FORBIDDEN");
  }));

test("approvals: a person other than the requester approves the exact packet digest before it expires; a re-run needs a new approval", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const run = await reconciled(org);
    const { packetId, digest } = await org.operator.mutation(api.review.request, { runId: run.runId });
    assert.equal(digest, run.packetDigest);

    await rejectsWith(org.operator.mutation(api.review.approve, { packetId, digest }), "FORBIDDEN", "SELF_APPROVAL");
    await rejectsWith(org.agent.mutation(api.review.approve, { packetId, digest }), "FORBIDDEN");
    await rejectsWith(org.owner.mutation(api.review.approve, { packetId, digest }), "FORBIDDEN"); // customers do not review exceptions
    await rejectsWith(org.reviewer.mutation(api.review.approve, { packetId, digest: `sha256:${"0".repeat(64)}` }), "FAILED_PRECONDITION", "DIGEST_MISMATCH");

    const ok = await org.reviewer.mutation(api.review.approve, { packetId, digest });
    assert.equal(ok.status, "approved");
    assert.equal((await org.reviewer.mutation(api.review.approve, { packetId, digest })).status, "existing");
    const [approval] = await org.owner.query(api.review.listApprovals, { packetId });
    assert.deepEqual([approval!.approvedBy, approval!.requestedBy, approval!.approverType, approval!.digest], ["olga", "otto", "user", digest]);

    // New QuickBooks content → new run → new packet: the earlier approval does not cover it.
    const s = scenario();
    const edited = s.bills.map((b) => (b.Id === "2" ? qboBill({ id: "2", vendor: "V2", date: "2026-10-04", doc: "A-77", lines: [{ id: "1", account: true, amount: 1003 }] }) : b));
    const snap2 = await org.operator.mutation(api.imports.record, { orderId: run.orderId, bills: edited, purchaseOrders: s.purchaseOrders });
    const run2 = await org.operator.mutation(api.runs.reconcileSnapshot, { snapshotId: snap2.snapshotId });
    const p2 = await org.operator.mutation(api.review.request, { runId: run2.runId });
    assert.notEqual(p2.digest, digest);
    assert.deepEqual(await org.owner.query(api.review.listApprovals, { packetId: p2.packetId }), []);
    await rejectsWith(org.reviewer.mutation(api.review.approve, { packetId: p2.packetId, digest }), "FAILED_PRECONDITION", "DIGEST_MISMATCH");

    // An expired review request cannot be approved.
    await raw(t, "packets").update(p2.packetId, { expiresAt: Date.now() - 1 });
    await rejectsWith(org.reviewer.mutation(api.review.approve, { packetId: p2.packetId, digest: p2.digest }), "FAILED_PRECONDITION", "EXPIRED");
  }));

test("customer decisions: only the customer's people, only for questions the contract leaves to them, once", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const run = await reconciled(org);
    const dup = "5:duplicate_invoice:-";
    await rejectsWith(org.operator.mutation(api.review.decide, { runId: run.runId, exceptionId: dup, decision: "confirmed" }), "FORBIDDEN");
    await rejectsWith(org.member.mutation(api.review.decide, { runId: run.runId, exceptionId: "4:no_po_reference:-", decision: "acknowledged" }), "FAILED_PRECONDITION");
    await org.member.mutation(api.review.decide, { runId: run.runId, exceptionId: dup, decision: "confirmed", note: "Entered twice; the second is void in QBO." });
    await rejectsWith(org.owner.mutation(api.review.decide, { runId: run.runId, exceptionId: dup, decision: "rejected" }), "CONFLICT");
    assert.deepEqual((await org.owner.query(api.integrity.check, {})).problems, []);
  }));

test("integrity: recomputation catches drift in source records, run outputs and approvals", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const run = await reconciled(org);
    const { packetId, digest } = await org.operator.mutation(api.review.request, { runId: run.runId });
    await org.reviewer.mutation(api.review.approve, { packetId, digest });
    const clean = await org.owner.query(api.integrity.check, {});
    assert.deepEqual(clean.problems, []);
    assert.deepEqual(clean.counts, { orders: 1, sourceRecords: 12, snapshots: 1, runs: 1, packets: 1, approvals: 1, decisions: 0 });

    // A source record edited in storage.
    const [rec] = await raw(t, "sourceRecords").find({ sourceId: "3", kind: "bill" });
    await raw(t, "sourceRecords").update(rec!.id, { record: { ...rec!.record, totalCents: 1 } });
    // A run output edited in storage, with its digest "fixed up" to match.
    const [r] = await raw(t, "runs").find({});
    const output = { ...r!.output, summary: { ...r!.output.summary, matched: 99 } };
    const { digest: digestOf } = await import("../src/canonical.js");
    await raw(t, "runs").update(r!.id, { output, outputDigest: digestOf(output) });
    // An approval whose approver was rewritten to the requester.
    const [ap] = await raw(t, "approvals").find({});
    await raw(t, "approvals").update(ap!.id, { approvedBy: "otto" });

    const problems = (await org.owner.query(api.integrity.check, {})).problems.join("\n");
    assert.match(problems, /source bill 3: content does not match its digest/);
    assert.match(problems, new RegExp(`run ${r!.id}: packet digest does not recompute`));
    assert.match(problems, new RegExp(`run ${r!.id}: output does not recompute from its snapshot`));
    assert.match(problems, new RegExp(`approval ${ap!.id}: approved by its requester`));
    // Review refuses to proceed on a run that no longer matches its packet.
    await rejectsWith(org.operator.mutation(api.review.request, { runId: run.runId }), "FAILED_PRECONDITION");
  }));
