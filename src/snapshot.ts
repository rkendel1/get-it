/**
 * A source snapshot: the exact bill-set records one review is computed from, as the customer
 * submitted them.
 *
 * - Every record (bill, vendor, account, prior bill) is content-addressed: `digest(record)` over
 *   its raw form.
 * - The manifest lists (kind, key, digest), sorted.
 * - The snapshot digest covers the review scope and the manifest, and not the time of import.
 *   Importing the same bill set twice, in any order, therefore yields the same snapshot, which is
 *   what makes imports idempotent.
 *
 * The raw records are the single source of truth: review re-validates them (pure), so a stored
 * snapshot can always be re-reviewed and compared.
 */
import { billKey, validateBillSet, type ValidatedBillSet } from "./bills.js";
import { digest } from "./canonical.js";
import type { FrozenContract } from "./contract.js";

export type SourceKind = "account" | "bill" | "priorBill" | "vendor";

export interface ManifestEntry {
  readonly kind: SourceKind;
  readonly key: string;
  readonly digest: string;
}

export interface ReviewScope {
  readonly homeCurrency: string;
  readonly timeZone: string;
  readonly asOfDate: string;
  readonly policy: { readonly documentRequiredOverMinor: number; readonly dueSoonBusinessDays: number };
}

export interface SourceRecord {
  readonly kind: SourceKind;
  readonly key: string;
  readonly digest: string;
  readonly record: unknown;
}

export interface Snapshot {
  readonly scope: ReviewScope;
  readonly manifest: readonly ManifestEntry[];
  readonly digest: string;
  readonly records: readonly SourceRecord[];
}

const order = (a: { kind: string; key: string }, b: { kind: string; key: string }) => (a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export function snapshotDigest(scope: ReviewScope, manifest: readonly ManifestEntry[]): string {
  return digest({ scope, manifest });
}

function keyOf(kind: SourceKind, record: unknown): string {
  const r = record as Record<string, unknown>;
  if (kind === "bill") return billKey(record);
  if (kind === "priorBill") return `prior:${digest(record).slice(7, 23)}`;
  return r.id as string; // vendors and accounts: validated ids
}

export interface AddressedBillSet {
  readonly manifest: readonly ManifestEntry[];
  readonly records: readonly SourceRecord[];
  /** The digest of the manifest alone: the bill set's identity, before any review scope is bound. */
  readonly digest: string;
  readonly counts: { readonly bills: number; readonly vendors: number; readonly accounts: number; readonly priorBills: number };
}

/**
 * Validate a raw bill set and content-address it. This is the one bill-set validator: intake's
 * upload and the order's import both go through it (buildSnapshot calls it). Throws BillSetError
 * for invalid reference data.
 */
export function addressBillSet(raw: unknown, contract: FrozenContract): AddressedBillSet {
  validateBillSet(raw, contract.limits);
  const r = raw as { vendors: unknown[]; accounts: unknown[]; bills: unknown[]; priorBills?: unknown[] };
  const records = new Map<string, SourceRecord>();
  for (const [kind, list] of [["vendor", r.vendors], ["account", r.accounts], ["bill", r.bills], ["priorBill", r.priorBills ?? []]] as const) {
    for (const record of list) {
      const key = keyOf(kind, record);
      records.set(`${kind}:${key}`, { kind, key, digest: digest(record), record }); // identical prior bills collapse
    }
  }
  const sorted = [...records.values()].sort(order);
  const manifest = sorted.map(({ kind, key, digest: d }) => ({ kind, key, digest: d }));
  const count = (kind: SourceKind) => manifest.filter((m) => m.kind === kind).length;
  return { manifest, records: sorted, digest: digest({ manifest }), counts: { bills: count("bill"), vendors: count("vendor"), accounts: count("account"), priorBills: count("priorBill") } };
}

/** Validate, content-address and bind a bill set to a review scope. */
export function buildSnapshot(scope: ReviewScope, raw: unknown, contract: FrozenContract): Snapshot {
  const { manifest, records } = addressBillSet(raw, contract);
  return { scope, manifest, digest: snapshotDigest(scope, manifest), records };
}

/** The validated set a snapshot holds (re-validated from its raw records). */
export function setOf(snapshot: Snapshot, contract: FrozenContract): ValidatedBillSet {
  const of = (kind: SourceKind) => snapshot.records.filter((x) => x.kind === kind).map((x) => x.record);
  return validateBillSet({ vendors: of("vendor"), accounts: of("account"), bills: of("bill"), priorBills: of("priorBill") }, contract.limits);
}
