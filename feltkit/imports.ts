/**
 * Importing QuickBooks Online records into an order, idempotently.
 *
 * The caller passes the raw QBO JSON exactly as the read-only connector returned it (`pullSource`).
 * Here it is normalized, content-addressed and recorded as a snapshot.
 *
 * - The same content imported twice is a `duplicate`: the same snapshot, nothing written.
 * - Changed content is a new snapshot. Only the records whose digest changed are added; the old
 *   versions stay, because facts are never overwritten.
 *
 * In Phase 1 an action pulls through the connector and calls this mutation.
 */
import { fail, s } from "@feltdb/feltkit";
import { digest } from "../src/canonical.js";
import { NormalizationError, normalizeBill, normalizePurchaseOrder } from "../src/qbo.js";
import { buildSnapshot } from "../src/snapshot.js";
import { app, audit, orders, snapshots, sourceRecords } from "./app.js";
import { requireTenant } from "./_guards.js";

export const record = app.mutation({
  access: "imports.write",
  args: { orderId: s.string(), bills: s.array(s.unknown()), purchaseOrders: s.array(s.unknown()) },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const order = await ctx.db.get(orders, a.orderId);
    if (!order) fail("NOT_FOUND", "No such order.");

    let normalized;
    try {
      const vendors = new Set(order.vendorIds);
      const bills = a.bills.map((b) => normalizeBill(b as Record<string, unknown>)).filter((b) => vendors.size === 0 || vendors.has(b.vendorId));
      for (const b of bills) if (b.txnDate < order.from || b.txnDate > order.to) fail("INVALID_ARGUMENT", `Bill ${b.id} (${b.txnDate}) is outside the order's period.`);
      normalized = { bills, purchaseOrders: a.purchaseOrders.map((p) => normalizePurchaseOrder(p as Record<string, unknown>)) };
    } catch (e) {
      if (e instanceof NormalizationError) fail("INVALID_ARGUMENT", `QuickBooks record refused: ${e.message}`);
      throw e;
    }

    const scope = { realmId: order.realmId, from: order.from, to: order.to, vendorIds: order.vendorIds, homeCurrency: order.homeCurrency };
    const snap = buildSnapshot(scope, normalized.bills, normalized.purchaseOrders);

    const [existing] = await ctx.db.find(snapshots, { orderId: order.id, digest: snap.digest });
    if (existing) return { status: "duplicate" as const, snapshotId: existing.id, digest: snap.digest, recordsAdded: 0 };

    const now = Date.now();
    const stored = new Set((await ctx.db.find(sourceRecords, { orderId: order.id })).map((r) => `${r.kind}:${r.sourceId}:${r.digest}`));
    let recordsAdded = 0;
    for (const [kind, list] of [["bill", snap.bills], ["purchaseOrder", snap.purchaseOrders]] as const) {
      for (const r of list) {
        const d = digest(r);
        if (stored.has(`${kind}:${r.id}:${d}`)) continue;
        await ctx.db.insert(sourceRecords, { tenantId, orderId: order.id, kind, sourceId: r.id, digest: d, record: r, importedAt: now });
        recordsAdded++;
      }
    }
    const snapshotId = await ctx.db.insert(snapshots, {
      tenantId,
      orderId: order.id,
      digest: snap.digest,
      scope,
      manifest: snap.manifest.map((m) => ({ ...m })),
      bills: snap.bills.length,
      purchaseOrders: snap.purchaseOrders.length,
      importedBy: ctx.auth.requirePrincipal().id,
      importedAt: now,
    });
    await audit.record(ctx, { subject: "snapshot", id: snapshotId, type: "snapshot.recorded", data: { orderId: order.id, digest: snap.digest, bills: snap.bills.length, purchaseOrders: snap.purchaseOrders.length, recordsAdded } });
    return { status: "recorded" as const, snapshotId, digest: snap.digest, recordsAdded };
  },
});

export const list = app.query({
  access: "imports.read",
  args: { orderId: s.string() },
  handler: async (ctx, a) => ctx.db.find(snapshots, { orderId: a.orderId }),
});
