/**
 * The eight acceptance criteria of `svc_bill_review_payable_prep@1.0.0`, as code. Each returns its
 * failures. An empty list means the criterion passed.
 *
 * A package is published only when every criterion except `on_time` passes; `on_time` is recorded.
 * A package that fails a criterion is not delivered and is not charged.
 */
import { digest } from "./canonical.js";
import type { FrozenContract } from "./contract.js";
import { PACKET_FILE, verifyPackage, type ApprovalPacket } from "./deliverables.js";
import { CHECKS, exceptionTypeOf, review, type ReviewOutput } from "./review.js";
import type { Snapshot } from "./snapshot.js";

export const CRITERIA = ["completeness", "traceability", "recomputation", "classification", "no_accounting_mutation", "package_integrity", "reviewed", "on_time"] as const;
export type CriterionId = (typeof CRITERIA)[number];

export interface PacketApproval {
  readonly packetDigest: string;
  readonly approvedBy: string;
  readonly approverType: string; // "user" for a person
  readonly requestedBy: string;
}

export interface Delivery {
  readonly snapshot: Snapshot;
  readonly output: ReviewOutput;
  readonly files: Readonly<Record<string, string>>;
  readonly approvals: readonly PacketApproval[];
  readonly publishedAt: number;
  /** The turnaround deadline; null while the clock is paused. */
  readonly deadline: number | null;
}

export type AcceptanceReport = Readonly<Record<CriterionId, readonly string[]>> & { readonly passed: boolean };

export function completeness(d: Delivery): string[] {
  const failures: string[] = [];
  const bills = new Set(d.snapshot.manifest.filter((m) => m.kind === "bill").map((m) => m.key));
  const seen = new Map<string, number>();
  for (const r of d.output.results) seen.set(r.billKey, (seen.get(r.billKey) ?? 0) + 1);
  for (const k of bills) if ((seen.get(k) ?? 0) !== 1) failures.push(`bill ${k} has ${seen.get(k) ?? 0} results`);
  for (const k of seen.keys()) if (!bills.has(k)) failures.push(`result for bill ${k}, which is not in the snapshot`);
  return failures;
}

export function traceability(d: Delivery): string[] {
  const manifest = new Set(d.snapshot.manifest.map((m) => `${m.kind}:${m.key}:${m.digest}`));
  const failures: string[] = [];
  const cite = (what: string, sources: ReadonlyArray<{ kind: string; key: string; digest: string }>) => {
    if (sources.length === 0) failures.push(`${what} cites no input`);
    for (const s of sources) if (!manifest.has(`${s.kind}:${s.key}:${s.digest}`)) failures.push(`${what} cites ${s.kind} ${s.key} (${s.digest}), not in the snapshot`);
  };
  for (const r of d.output.results) cite(`result ${r.billKey}`, [r.source, ...r.references]);
  for (const e of d.output.exceptions) cite(`exception ${e.id}`, e.sources);
  for (const q of d.output.requests) cite(`request ${q.id}`, q.sources);
  for (const r of d.output.recommendations) cite(`recommendation ${r.billKey}`, r.sources);
  for (const x of d.output.documents) cite(`document ${x.billKey}/${x.ref}`, x.sources);
  return failures;
}

export function recomputation(d: Delivery, contract: FrozenContract): string[] {
  if (d.output.snapshotDigest !== d.snapshot.digest) return [`output was computed from snapshot ${d.output.snapshotDigest}, not ${d.snapshot.digest}`];
  if (d.output.contractDigest !== contract.digest) return [`output was computed under contract ${d.output.contractDigest}, not ${contract.digest}`];
  const again = review(d.snapshot, contract);
  if (digest(again) === digest(d.output)) return [];
  const mine = new Map(again.results.map((r) => [r.billKey, digest(r)]));
  const failures = d.output.results.filter((r) => mine.get(r.billKey) !== digest(r)).map((r) => `result ${r.billKey} does not recompute`);
  return failures.length ? failures : ["output does not recompute"];
}

/** Each status is the first, in contract order, among the bill's exceptions; each exception agrees with a failed check. */
export function classification(d: Delivery, contract: FrozenContract): string[] {
  const failures: string[] = [];
  const rank = new Map(contract.statuses.map((s, i) => [s, i]));
  const byId = new Map(d.output.exceptions.map((e) => [e.id, e]));
  for (const r of d.output.results) {
    if (r.checks.map((c) => c.id).join() !== CHECKS.join()) failures.push(`result ${r.billKey}: checks are not the contract's checks`);
    const failed = new Set(r.checks.filter((c) => c.outcome === "fail").map((c) => exceptionTypeOf(c.id)));
    const raised = r.exceptionIds.map((id) => byId.get(id));
    if (raised.some((e) => !e)) failures.push(`result ${r.billKey}: names an exception that does not exist`);
    const types = new Set(raised.filter((e) => e).map((e) => e!.type));
    for (const t of failed) if (!types.has(t)) failures.push(`result ${r.billKey}: failed check without its ${t} exception`);
    for (const t of types) if (!failed.has(t)) failures.push(`result ${r.billKey}: ${t} exception without a failed check`);
    for (const e of raised) if (e && contract.exceptionTypes.get(e.type)?.status !== e.status) failures.push(`exception ${e.id}: status ${e.status} is not the contract's for ${e.type}`);
    const expected = raised.length ? raised.map((e) => e!.status).sort((a, b) => rank.get(a)! - rank.get(b)!)[0] : "ready_for_payable_approval";
    if (r.status !== expected) failures.push(`result ${r.billKey}: status ${r.status}, its exceptions say ${expected}`);
  }
  return failures;
}

export function noAccountingMutation(d: Delivery, contract: FrozenContract): string[] {
  const failures: string[] = [];
  for (const r of d.output.recommendations) {
    if (r.advisory !== true) failures.push(`recommendation ${r.billKey} is not advisory`);
    if (!contract.recommendationValues.includes(r.recommendation)) failures.push(`recommendation ${r.billKey}: ${r.recommendation} is not a contract value`);
  }
  for (const rec of d.snapshot.records) if (digest(rec.record) !== rec.digest) failures.push(`input ${rec.kind} ${rec.key} no longer matches its digest`);
  return failures;
}

export function packageIntegrity(d: Delivery): string[] {
  const failures = verifyPackage(d.files);
  if (failures.length) return failures;
  const packet = JSON.parse(d.files[PACKET_FILE]!) as ApprovalPacket;
  if (packet.outputDigest !== digest(d.output)) failures.push("the packet names a different output");
  if (packet.snapshotDigest !== d.snapshot.digest) failures.push("the packet names a different snapshot");
  return failures;
}

export function reviewed(d: Delivery): string[] {
  const packetText = d.files[PACKET_FILE];
  if (!packetText) return ["no approval packet"];
  const packetDigest = digest(JSON.parse(packetText));
  return d.approvals.some((a) => a.packetDigest === packetDigest && a.approverType === "user" && a.approvedBy !== a.requestedBy) ? [] : [`no person other than the requester approved packet ${packetDigest}`];
}

export function onTime(d: Delivery): string[] {
  if (d.deadline === null) return ["the turnaround clock is paused: there is no deadline to meet"];
  return d.publishedAt <= d.deadline ? [] : [`published at ${new Date(d.publishedAt).toISOString()}, after the deadline ${new Date(d.deadline).toISOString()}`];
}

export function evaluate(d: Delivery, contract: FrozenContract): AcceptanceReport {
  const r: Record<CriterionId, string[]> = {
    completeness: completeness(d),
    traceability: traceability(d),
    recomputation: recomputation(d, contract),
    classification: classification(d, contract),
    no_accounting_mutation: noAccountingMutation(d, contract),
    package_integrity: packageIntegrity(d),
    reviewed: reviewed(d),
    on_time: onTime(d),
  };
  return { ...r, passed: Object.values(r).every((f) => f.length === 0) };
}

/** Publication requires every criterion except on_time; lateness is recorded, not hidden. */
export const publishable = (r: AcceptanceReport) => CRITERIA.every((c) => c === "on_time" || r[c].length === 0);
