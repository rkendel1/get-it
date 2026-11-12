/**
 * Reconciliation runs. A run is a pure function of (snapshot, contract), so running the same pair
 * again returns the recorded run instead of writing a second one.
 */
import { fail, s } from "@feltdb/feltkit";
import { digest } from "../src/canonical.js";
import { packetDigest, reconcile } from "../src/reconcile.js";
import { app, audit, orders, runs, snapshots } from "./app.js";
import { CONTRACT, loadSnapshot, requireTenant } from "./_guards.js";

export const reconcileSnapshot = app.mutation({
  access: "runs.write",
  args: { snapshotId: s.string() },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const snap = await ctx.db.get(snapshots, a.snapshotId);
    if (!snap) fail("NOT_FOUND", "No such snapshot.");
    const order = await ctx.db.get(orders, snap.orderId);
    if (!order) fail("NOT_FOUND", "No such order.");
    if (order.contractDigest !== CONTRACT.digest) fail("FAILED_PRECONDITION", `Order is bound to ${order.contract} ${order.contractDigest}; this deployment runs ${CONTRACT.key} ${CONTRACT.digest}.`);

    const [existing] = await ctx.db.find(runs, { snapshotId: snap.id, contractDigest: CONTRACT.digest });
    if (existing) return { status: "duplicate" as const, runId: existing.id, outputDigest: existing.outputDigest, packetDigest: existing.packetDigest };

    const output = reconcile(await loadSnapshot(ctx, snap), CONTRACT);
    const outputDigest = digest(output);
    const packet = packetDigest(output);
    const runId = await ctx.db.insert(runs, {
      tenantId,
      orderId: order.id,
      snapshotId: snap.id,
      snapshotDigest: snap.digest,
      contractDigest: CONTRACT.digest,
      outputDigest,
      packetDigest: packet,
      output,
      createdBy: ctx.auth.requirePrincipal().id,
      createdAt: Date.now(),
    });
    if (order.status === "intake") await ctx.db.patch(orders, order.id, { status: "running" });
    await audit.record(ctx, { subject: "run", id: runId, type: "run.recorded", data: { snapshotDigest: snap.digest, outputDigest, packetDigest: packet, summary: output.summary } });
    return { status: "recorded" as const, runId, outputDigest, packetDigest: packet };
  },
});

export const get = app.query({
  access: "runs.read",
  args: { id: s.string() },
  handler: async (ctx, a) => ctx.db.get(runs, a.id),
});
