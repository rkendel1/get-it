/**
 * A source snapshot: the exact canonical records one reconciliation is computed from.
 *
 * - Each record is content-addressed (`digest(record)`).
 * - The manifest lists (kind, id, digest), sorted.
 * - The snapshot digest covers the scope and the manifest, and not the fetch time. Importing the
 *   same QuickBooks content twice therefore yields the same snapshot, which is what makes imports
 *   idempotent.
 */
import { digest } from "./canonical.js";
import type { CanonicalBill, CanonicalPurchaseOrder, SourceScope } from "./qbo.js";

export type SourceKind = "bill" | "purchaseOrder";

export interface ManifestEntry {
  readonly kind: SourceKind;
  readonly id: string;
  readonly digest: string;
}

export interface Snapshot {
  readonly scope: SourceScope & { readonly homeCurrency: string };
  readonly manifest: readonly ManifestEntry[];
  readonly digest: string;
  readonly bills: readonly CanonicalBill[];
  readonly purchaseOrders: readonly CanonicalPurchaseOrder[];
}

const byKindId = (a: ManifestEntry, b: ManifestEntry) => (a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function snapshotDigest(scope: Snapshot["scope"], manifest: readonly ManifestEntry[]): string {
  return digest({ scope: { ...scope, vendorIds: [...scope.vendorIds].sort() }, manifest });
}

export function buildSnapshot(scope: Snapshot["scope"], bills: readonly CanonicalBill[], purchaseOrders: readonly CanonicalPurchaseOrder[]): Snapshot {
  for (const [kind, list] of [["bill", bills], ["purchaseOrder", purchaseOrders]] as const) {
    const seen = new Set<string>();
    for (const r of list) {
      if (seen.has(r.id)) throw new Error(`snapshot: ${kind} ${r.id} appears twice`);
      seen.add(r.id);
    }
  }
  const manifest = [
    ...bills.map((b) => ({ kind: "bill" as const, id: b.id, digest: digest(b) })),
    ...purchaseOrders.map((p) => ({ kind: "purchaseOrder" as const, id: p.id, digest: digest(p) })),
  ].sort(byKindId);
  const sortById = <T extends { id: string }>(xs: readonly T[]) => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { scope, manifest, digest: snapshotDigest(scope, manifest), bills: sortById(bills), purchaseOrders: sortById(purchaseOrders) };
}
