/**
 * Guards shared by get-it's functions. (A leading underscore: a helper module, not functions.)
 */
import { fail, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { loadFrozenContract } from "../src/contract.js";
import type { CanonicalBill, CanonicalPurchaseOrder } from "../src/qbo.js";
import type { Snapshot } from "../src/snapshot.js";
import { sourceRecords } from "./app.js";

/** The contract every order is bound to, verified against its frozen digest at load. */
export const CONTRACT = loadFrozenContract();

/** The tenant the session works in. get-it writes it explicitly on every record. */
export function requireTenant(ctx: QueryCtx | MutationCtx): string {
  const tenant = ctx.auth.tenant as { id?: string } | null | undefined;
  if (!tenant?.id) fail("FAILED_PRECONDITION", "Choose an organization first.", { hint: "NO_TENANT" });
  return tenant.id;
}

/** Approvals and customer decisions are taken by people, never by agents or services. */
export function requirePerson(ctx: QueryCtx | MutationCtx) {
  const p = ctx.auth.requirePrincipal();
  if (p.type !== "user") fail("FORBIDDEN", "Only a person can approve or decide. Agents and services cannot.");
  return p;
}

/** Rebuild a stored snapshot from its manifest and the content-addressed source records. */
export async function loadSnapshot(ctx: QueryCtx | MutationCtx, snap: { orderId: string; digest: string; scope: unknown; manifest: Array<{ kind: "bill" | "purchaseOrder"; id: string; digest: string }> }): Promise<Snapshot> {
  const stored = await ctx.db.find(sourceRecords, { orderId: snap.orderId });
  const byKey = new Map(stored.map((r) => [`${r.kind}:${r.sourceId}:${r.digest}`, r.record]));
  const bills: CanonicalBill[] = [];
  const purchaseOrders: CanonicalPurchaseOrder[] = [];
  for (const m of snap.manifest) {
    const record = byKey.get(`${m.kind}:${m.id}:${m.digest}`);
    if (record === undefined) fail("FAILED_PRECONDITION", `Snapshot ${snap.digest} names ${m.kind} ${m.id}, which is not stored.`);
    (m.kind === "bill" ? bills : purchaseOrders).push(record as never);
  }
  return { scope: snap.scope as Snapshot["scope"], manifest: snap.manifest, digest: snap.digest, bills, purchaseOrders };
}
