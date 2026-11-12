/**
 * The seven acceptance criteria of `svc_invoice_reconciliation@1.0.0`, as code. Each returns its
 * failures. An empty list means the criterion passed. Delivery is blocked unless all seven pass;
 * the results are part of the evidence package.
 */
import { digest } from "./canonical.js";
import type { FrozenContract } from "./contract.js";
import { READ_OPERATIONS, type Invocation } from "./qbo.js";
import { packetDigest, reconcile, type ReconciledRecord, type ReconciliationOutput } from "./reconcile.js";
import type { Snapshot } from "./snapshot.js";
import { quantityWithin, totalWithin, unitPriceWithin } from "./tolerance.js";

export type CriterionId = "completeness" | "traceability" | "arithmetic" | "tolerance" | "read_only" | "reviewed" | "on_time";

export interface PacketApproval {
  readonly packetDigest: string;
  readonly approvedBy: string;
  readonly approverType: string; // "user" for a person
  readonly requestedBy: string;
}

export interface Delivery {
  readonly snapshot: Snapshot;
  readonly output: ReconciliationOutput;
  /** Connector invocations made for the order (from QboReadOnlyConnector.invocations). */
  readonly invocations: readonly Invocation[];
  readonly approvals: readonly PacketApproval[];
  readonly publishedAt: number;
  /** The turnaround deadline; null while paused (then on_time cannot pass). */
  readonly deadline: number | null;
}

export type AcceptanceReport = Readonly<Record<CriterionId, readonly string[]>> & { readonly passed: boolean };

export function completeness(d: Delivery): string[] {
  const failures: string[] = [];
  const inSnapshot = new Set(d.snapshot.bills.map((b) => b.id));
  const seen = new Map<string, number>();
  for (const r of d.output.records) seen.set(r.billId, (seen.get(r.billId) ?? 0) + 1);
  for (const id of inSnapshot) if ((seen.get(id) ?? 0) !== 1) failures.push(`bill ${id} has ${seen.get(id) ?? 0} records`);
  for (const id of seen.keys()) if (!inSnapshot.has(id)) failures.push(`record for bill ${id}, which is not in the snapshot`);
  return failures;
}

export function traceability(d: Delivery): string[] {
  const failures: string[] = [];
  const manifest = new Set(d.snapshot.manifest.map((m) => `${m.kind}:${m.id}:${m.digest}`));
  const check = (what: string, sources: readonly { kind: string; id: string; digest: string }[]) => {
    if (sources.length === 0) failures.push(`${what} cites no source`);
    for (const s of sources) if (!manifest.has(`${s.kind}:${s.id}:${s.digest}`)) failures.push(`${what} cites ${s.kind} ${s.id} (${s.digest}), not in the snapshot manifest`);
  };
  for (const r of d.output.records) check(`record ${r.billId}`, r.sources);
  for (const e of d.output.exceptions) check(`exception ${e.id}`, e.sources);
  return failures;
}

export function arithmetic(d: Delivery, contract: FrozenContract): string[] {
  if (d.output.snapshotDigest !== d.snapshot.digest) return [`output was computed from snapshot ${d.output.snapshotDigest}, not ${d.snapshot.digest}`];
  if (d.output.contractDigest !== contract.digest) return [`output was computed under contract ${d.output.contractDigest}, not ${contract.digest}`];
  const recomputed = reconcile(d.snapshot, contract);
  if (digest(recomputed) === digest(d.output)) return [];
  const failures: string[] = [];
  const mine = new Map(recomputed.records.map((r) => [r.billId, digest(r)]));
  for (const r of d.output.records) if (mine.get(r.billId) !== digest(r)) failures.push(`record ${r.billId} does not recompute`);
  const exceptionIds = (o: ReconciliationOutput) => o.exceptions.map((e) => digest(e)).sort().join("|");
  if (exceptionIds(recomputed) !== exceptionIds(d.output)) failures.push("exceptions do not recompute");
  if (digest(recomputed.summary) !== digest(d.output.summary)) failures.push("summary does not recompute");
  return failures.length ? failures : ["output does not recompute"];
}

/** Status and per-line flags agree with the stored numbers under the contract tolerances. */
export function tolerance(d: Delivery, contract: FrozenContract): string[] {
  const t = contract.tolerances;
  const failures: string[] = [];
  const exceptionsOf = new Map<string, string[]>();
  for (const e of d.output.exceptions) exceptionsOf.set(e.billId, [...(exceptionsOf.get(e.billId) ?? []), e.type]);
  for (const r of d.output.records as readonly ReconciledRecord[]) {
    const types = exceptionsOf.get(r.billId) ?? [];
    let nonZero = false;
    for (const l of r.lines) {
      if (l.poUnitPriceMicros === null || l.poQuantityMicros === null) continue;
      const priceOk = unitPriceWithin(l.billUnitPriceMicros, l.poUnitPriceMicros, t);
      const qtyOk = quantityWithin(l.billQuantityMicros, l.poQuantityMicros, t);
      if (priceOk !== l.unitPriceWithin) failures.push(`bill ${r.billId} line ${l.lineId}: unit price flag disagrees with the tolerance`);
      if (qtyOk !== l.quantityExact) failures.push(`bill ${r.billId} line ${l.lineId}: quantity flag disagrees with the rule`);
      if (!priceOk && !types.includes("price_variance")) failures.push(`bill ${r.billId} line ${l.lineId}: price outside tolerance without a price_variance exception`);
      if (!qtyOk && !types.includes("quantity_variance")) failures.push(`bill ${r.billId} line ${l.lineId}: quantity differs without a quantity_variance exception`);
      if (l.billUnitPriceMicros !== l.poUnitPriceMicros) nonZero = true;
    }
    if (r.expectedTotalCents !== null) {
      const ok = totalWithin(r.lineTotalCents, r.expectedTotalCents, t);
      if (ok !== r.totalWithin) failures.push(`bill ${r.billId}: total flag disagrees with the tolerance`);
      if (!ok && !types.includes("total_variance")) failures.push(`bill ${r.billId}: total outside tolerance without a total_variance exception`);
      if (r.lineTotalCents !== r.expectedTotalCents) nonZero = true;
    }
    const expected =
      types.some((x) => x === "no_po_reference" || x === "po_not_found") ? "unmatched" : types.length ? "discrepancy" : nonZero ? "matched_within_tolerance" : "matched";
    if (r.status !== expected) failures.push(`bill ${r.billId}: status ${r.status}, the variances say ${expected}`);
  }
  return failures;
}

export function readOnly(d: Delivery): string[] {
  const reads = new Set<string>(READ_OPERATIONS);
  return d.invocations.flatMap((i) => {
    if (i.effect !== "observation") return [`${i.operation} was attempted and refused (${i.refusal ?? "refused"})`];
    if (!reads.has(i.operation)) return [`${i.operation} is not a read operation`];
    return [];
  });
}

export function reviewed(d: Delivery): string[] {
  const needing = d.output.exceptions.filter((e) => e.requiresReview);
  if (needing.length === 0) return [];
  const packet = packetDigest(d.output);
  const valid = d.approvals.some((a) => a.packetDigest === packet && a.approverType === "user" && a.approvedBy !== a.requestedBy);
  return valid ? [] : [`${needing.length} exception(s) require review and no person approved packet ${packet}`];
}

export function onTime(d: Delivery): string[] {
  if (d.deadline === null) return ["the turnaround clock is paused: there is no deadline to meet"];
  return d.publishedAt <= d.deadline ? [] : [`published at ${new Date(d.publishedAt).toISOString()}, after the deadline ${new Date(d.deadline).toISOString()}`];
}

export function evaluate(d: Delivery, contract: FrozenContract): AcceptanceReport {
  const r = {
    completeness: completeness(d),
    traceability: traceability(d),
    arithmetic: arithmetic(d, contract),
    tolerance: tolerance(d, contract),
    read_only: readOnly(d),
    reviewed: reviewed(d),
    on_time: onTime(d),
  };
  return { ...r, passed: Object.values(r).every((f) => f.length === 0) };
}
