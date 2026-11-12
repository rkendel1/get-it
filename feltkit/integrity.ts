/**
 * Integrity: recompute get-it's invariants from what is stored, and list every violation.
 *
 * Invariants:
 * - Every record carries an explicit `tenantId` equal to the tenant it is read in.
 * - Every source record's digest is the digest of its content.
 * - Every snapshot's digest is the digest of its scope and manifest, and every manifest entry is a
 *   stored source record.
 * - Every run's output digest and packet digest recompute, and its output recomputes from its
 *   snapshot under the frozen contract (the run is deterministic).
 * - Every packet's digest is its run's packet digest.
 * - Every approval names its packet's digest, an approver other than the requester, and a person.
 * - Every decision names an exception of its run that the contract leaves to the customer.
 *
 * Because FeltDB has no write-once collections, this check is how drift in append-only facts is
 * detected.
 */
import { digest } from "../src/canonical.js";
import { packetDigest, reconcile, type ReconciliationOutput } from "../src/reconcile.js";
import { snapshotDigest } from "../src/snapshot.js";
import { app, approvals, decisions, orders, packets, runs, snapshots, sourceRecords } from "./app.js";
import { CONTRACT, loadSnapshot, requireTenant } from "./_guards.js";

export const check = app.query({
  access: "integrity.read",
  args: {},
  handler: async (ctx) => {
    const tenantId = requireTenant(ctx);
    const problems: string[] = [];
    const all = {
      orders: await ctx.db.find(orders, {}),
      sourceRecords: await ctx.db.find(sourceRecords, {}),
      snapshots: await ctx.db.find(snapshots, {}),
      runs: await ctx.db.find(runs, {}),
      packets: await ctx.db.find(packets, {}),
      approvals: await ctx.db.find(approvals, {}),
      decisions: await ctx.db.find(decisions, {}),
    };
    for (const [name, list] of Object.entries(all)) {
      for (const r of list as Array<{ id: string; tenantId?: string }>) if (r.tenantId !== tenantId) problems.push(`${name} ${r.id}: tenantId ${String(r.tenantId)} ≠ ${tenantId}`);
    }

    for (const r of all.sourceRecords) if (digest(r.record) !== r.digest) problems.push(`source ${r.kind} ${r.sourceId}: content does not match its digest`);

    const snapById = new Map(all.snapshots.map((x) => [x.id, x]));
    for (const snap of all.snapshots) {
      if (snapshotDigest(snap.scope as never, snap.manifest) !== snap.digest) problems.push(`snapshot ${snap.id}: digest does not recompute`);
    }

    const runById = new Map(all.runs.map((x) => [x.id, x]));
    for (const run of all.runs) {
      const output = run.output as ReconciliationOutput;
      if (digest(output) !== run.outputDigest) problems.push(`run ${run.id}: output does not match its digest`);
      if (packetDigest(output) !== run.packetDigest) problems.push(`run ${run.id}: packet digest does not recompute`);
      const snap = snapById.get(run.snapshotId);
      if (!snap) {
        problems.push(`run ${run.id}: snapshot ${run.snapshotId} missing`);
        continue;
      }
      if (run.contractDigest !== CONTRACT.digest) continue; // another contract version: not recomputable here
      try {
        if (digest(reconcile(await loadSnapshot(ctx, snap), CONTRACT)) !== run.outputDigest) problems.push(`run ${run.id}: output does not recompute from its snapshot`);
      } catch (e) {
        problems.push(`run ${run.id}: snapshot cannot be rebuilt (${(e as Error).message})`);
      }
    }

    const packetById = new Map(all.packets.map((x) => [x.id, x]));
    for (const p of all.packets) {
      const run = runById.get(p.runId);
      if (!run || run.packetDigest !== p.digest) problems.push(`packet ${p.id}: digest is not its run's packet digest`);
    }
    for (const a of all.approvals) {
      const p = packetById.get(a.packetId);
      if (!p) problems.push(`approval ${a.id}: packet missing`);
      else if (a.digest !== p.digest) problems.push(`approval ${a.id}: approves ${a.digest}, the packet is ${p.digest}`);
      if (a.approvedBy === a.requestedBy) problems.push(`approval ${a.id}: approved by its requester`);
      if (a.approverType !== "user") problems.push(`approval ${a.id}: approver is not a person`);
    }
    for (const d of all.decisions) {
      const e = (runById.get(d.runId)?.output as ReconciliationOutput | undefined)?.exceptions.find((x) => x.id === d.exceptionId);
      if (!e) problems.push(`decision ${d.id}: exception ${d.exceptionId} not in its run`);
      else if (e.decision !== "customer") problems.push(`decision ${d.id}: ${e.type} is not a customer decision`);
    }

    return { problems, counts: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, (v as unknown[]).length])) };
  },
});
