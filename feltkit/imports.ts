/**
 * Importing a customer's Ledger-compatible bill set into an order, idempotently.
 *
 * - The same bill set imported twice, in any order, is a `duplicate`: the same snapshot, and
 *   nothing written.
 * - A changed set is a new snapshot. Only the records whose content changed are added; earlier
 *   versions stay, because facts are never overwritten.
 * - Invalid reference data (vendors, accounts, prior bills) refuses the whole import with every
 *   issue listed. An invalid bill is imported and reviewed as `rejected_malformed`.
 *
 * The first complete bill set starts the turnaround clock.
 */
import { fail, s } from "@feltdb/feltkit";
import { BillSetError } from "../src/bills.js";
import { buildSnapshot } from "../src/snapshot.js";
import { app, audit, orders, snapshots, sourceRecords } from "./app.js";
import { CONTRACT, requireTenant } from "./_guards.js";

export const record = app.mutation({
  access: "imports.write",
  args: { orderId: s.string(), billSet: s.unknown() },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const order = await ctx.db.get(orders, a.orderId);
    if (!order) fail("NOT_FOUND", "No such order.");
    if (order.status === "accepted") fail("FAILED_PRECONDITION", "The order has been accepted.");

    const scope = { homeCurrency: order.homeCurrency, timeZone: order.timeZone, asOfDate: order.asOfDate, policy: order.policy };
    let snap;
    try {
      snap = buildSnapshot(scope, a.billSet, CONTRACT);
    } catch (e) {
      if (e instanceof BillSetError) fail("INVALID_ARGUMENT", e.message, { hint: "BILL_SET_INVALID", issues: e.issues });
      throw e;
    }

    const [existing] = await ctx.db.find(snapshots, { orderId: order.id, digest: snap.digest });
    if (existing) return { status: "duplicate" as const, snapshotId: existing.id, digest: snap.digest, recordsAdded: 0 };

    const now = Date.now();
    const stored = new Set((await ctx.db.find(sourceRecords, { orderId: order.id })).map((r) => `${r.kind}:${r.key}:${r.digest}`));
    let recordsAdded = 0;
    for (const r of snap.records) {
      if (stored.has(`${r.kind}:${r.key}:${r.digest}`)) continue;
      await ctx.db.insert(sourceRecords, { tenantId, orderId: order.id, kind: r.kind, key: r.key, digest: r.digest, record: r.record, importedAt: now });
      recordsAdded++;
    }
    const snapshotId = await ctx.db.insert(snapshots, {
      tenantId,
      orderId: order.id,
      digest: snap.digest,
      scope,
      manifest: snap.manifest.map((m) => ({ ...m })),
      bills: snap.manifest.filter((m) => m.kind === "bill").length,
      importedBy: ctx.auth.requirePrincipal().id,
      importedAt: now,
    });
    if (order.clockStartedAt === undefined) await ctx.db.patch(orders, order.id, { clockStartedAt: now });
    await audit.record(ctx, { subject: "snapshot", id: snapshotId, type: "snapshot.recorded", data: { orderId: order.id, digest: snap.digest, recordsAdded } });
    return { status: "recorded" as const, snapshotId, digest: snap.digest, recordsAdded };
  },
});

export const list = app.query({
  access: "imports.read",
  args: { orderId: s.string() },
  handler: async (ctx, a) => ctx.db.find(snapshots, { orderId: a.orderId }),
});
