/**
 * The seven acceptance criteria: a correct delivery passes all of them, and each criterion catches
 * the failure it exists for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type Delivery } from "../src/acceptance.js";
import { turnaroundDeadline } from "../src/calendar.js";
import { loadFrozenContract } from "../src/contract.js";
import { pullSource, QboReadOnlyConnector, type QboRequest } from "../src/qbo.js";
import { packetDigest, reconcile } from "../src/reconcile.js";
import { buildSnapshot } from "../src/snapshot.js";
import { scenario } from "./_qbo.js";

const contract = loadFrozenContract();
const at = (iso: string) => Date.parse(iso);

async function delivery(): Promise<Delivery> {
  const s = scenario();
  const transport = async (r: QboRequest) => {
    const entity = /FROM (\w+)/.exec(r.query?.query ?? "")![1]!;
    return { QueryResponse: { [entity]: entity === "Bill" ? s.bills : s.purchaseOrders } };
  };
  const connector = new QboReadOnlyConnector({ realmId: "9130", transport });
  const scope = { realmId: "9130", from: "2026-10-01", to: "2026-10-31", vendorIds: [] as string[] };
  const source = await pullSource(connector, scope);
  const snapshot = buildSnapshot({ ...scope, homeCurrency: "USD" }, source.bills, source.purchaseOrders);
  const output = reconcile(snapshot, contract);
  const start = at("2026-11-02T14:00:00Z"); // Monday 09:00 New York
  const { deadline } = turnaroundDeadline({ start, timeZone: "America/New_York", businessDays: 2, blockedLimitBusinessDays: 10, now: start });
  return {
    snapshot,
    output,
    invocations: connector.invocations,
    approvals: [{ packetDigest: packetDigest(output), approvedBy: "olga", approverType: "user", requestedBy: "otto" }],
    publishedAt: at("2026-11-04T20:00:00Z"), // Wednesday 15:00, deadline Wednesday 23:59:59.999
    deadline,
  };
}

const failing = (d: Delivery) => Object.entries(evaluate(d, contract)).filter(([k, v]) => k !== "passed" && (v as string[]).length > 0).map(([k]) => k);

test("a correct delivery passes all seven criteria", async () => {
  const d = await delivery();
  const r = evaluate(d, contract);
  assert.ok(r.passed, JSON.stringify(r, null, 2));
});

test("completeness: a missing or extra record fails", async () => {
  const d = await delivery();
  const dropped = { ...d, output: { ...d.output, records: d.output.records.slice(1) } };
  assert.ok(failing(dropped).includes("completeness"));
  const extra = { ...d, output: { ...d.output, records: [...d.output.records, { ...d.output.records[0]!, billId: "999" }] } };
  assert.ok(failing(extra).includes("completeness"));
});

test("traceability: a source that is not in the manifest fails", async () => {
  const d = await delivery();
  const [first, ...rest] = d.output.records;
  const forged = { ...first!, sources: [{ ...first!.sources[0]!, digest: `sha256:${"0".repeat(64)}` }] };
  assert.ok(failing({ ...d, output: { ...d.output, records: [forged, ...rest] } }).includes("traceability"));
});

test("arithmetic: an output that does not recompute fails", async () => {
  const d = await delivery();
  const [e, ...rest] = d.output.exceptions;
  // Altering the output also changes its packet digest, so the approval no longer covers it.
  assert.deepEqual(failing({ ...d, output: { ...d.output, exceptions: [{ ...e!, amountAtStakeCents: e!.amountAtStakeCents - 1 }, ...rest] } }), ["arithmetic", "reviewed"]);
});

test("tolerance: a status the variances do not support fails", async () => {
  const d = await delivery();
  const records = d.output.records.map((r) => (r.billId === "3" ? { ...r, status: "matched" as const } : r));
  assert.ok(failing({ ...d, output: { ...d.output, records } }).includes("tolerance"));
});

test("read_only: any refused mutation attempt fails", async () => {
  const d = await delivery();
  const invocations = [...d.invocations, { operation: "bill.update", effect: "refused" as const, refusal: "MUTATION_REFUSED" as const, requests: 0, at: 0 }];
  assert.deepEqual(failing({ ...d, invocations }), ["read_only"]);
});

test("reviewed: the review-requiring exception needs a person's approval of this exact packet by someone other than the requester", async () => {
  const d = await delivery();
  const a = d.approvals[0]!;
  assert.deepEqual(failing({ ...d, approvals: [] }), ["reviewed"]);
  assert.deepEqual(failing({ ...d, approvals: [{ ...a, approvedBy: a.requestedBy }] }), ["reviewed"]);
  assert.deepEqual(failing({ ...d, approvals: [{ ...a, approverType: "agent" }] }), ["reviewed"]);
  assert.deepEqual(failing({ ...d, approvals: [{ ...a, packetDigest: `sha256:${"1".repeat(64)}` }] }), ["reviewed"], "an approval of another packet does not carry over");
});

test("on_time: after the deadline, or with the clock paused, fails", async () => {
  const d = await delivery();
  assert.deepEqual(failing({ ...d, publishedAt: d.deadline! + 1 }), ["on_time"]);
  assert.deepEqual(failing({ ...d, deadline: null }), ["on_time"]);
});
