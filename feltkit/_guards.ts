/**
 * Guards and loaders shared by get-it's functions. (A leading underscore: a helper module, not functions.)
 */
import { fail, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { turnaroundDeadline, type BlockedInterval } from "../src/calendar.js";
import { loadFrozenContract } from "../src/contract.js";
import type { ReviewScope, Snapshot, SourceKind } from "../src/snapshot.js";
import { blockEvents, sourceRecords } from "./app.js";

/** The contract every order is bound to, verified against its frozen digest at load. */
export const CONTRACT = loadFrozenContract();

/** The tenant the session works in. get-it writes it explicitly on every record. */
export function requireTenant(ctx: QueryCtx | MutationCtx): string {
  const tenant = ctx.auth.tenant as { id?: string } | null | undefined;
  if (!tenant?.id) fail("FAILED_PRECONDITION", "Choose an organization first.", { hint: "NO_TENANT" });
  return tenant.id;
}

/** Approvals, decisions, acceptances and corrections are taken by people, never by agents or services. */
export function requirePerson(ctx: QueryCtx | MutationCtx) {
  const p = ctx.auth.requirePrincipal();
  if (p.type !== "user") fail("FORBIDDEN", "Only a person can do this. Agents and services cannot.", { hint: "NOT_A_PERSON" });
  return p;
}

interface StoredSnapshot {
  digest: string;
  scope: unknown;
  manifest: Array<{ kind: SourceKind; key: string; digest: string }>;
}

/** The content-addressed records a manifest names, read from the tenant's source records. */
export async function loadRecords(ctx: QueryCtx | MutationCtx, manifest: ReadonlyArray<{ kind: SourceKind; key: string; digest: string }>, what: string) {
  const records = [];
  for (const m of manifest) {
    const [r] = await ctx.db.find(sourceRecords, { kind: m.kind, key: m.key, digest: m.digest });
    if (!r) fail("FAILED_PRECONDITION", `${what} names ${m.kind} ${m.key}, which is not stored.`);
    records.push({ ...m, record: r.record });
  }
  return records;
}

/** Rebuild a stored snapshot from its manifest and the content-addressed source records. */
export async function loadSnapshot(ctx: QueryCtx | MutationCtx, snap: StoredSnapshot): Promise<Snapshot> {
  return { scope: snap.scope as ReviewScope, manifest: snap.manifest, digest: snap.digest, records: await loadRecords(ctx, snap.manifest, `Snapshot ${snap.digest}`) };
}

/** Store the records of an addressed bill set that the tenant does not hold yet. Returns how many were added. */
export async function storeRecords(ctx: MutationCtx, tenantId: string, records: ReadonlyArray<{ kind: SourceKind; key: string; digest: string; record: unknown }>): Promise<number> {
  let added = 0;
  const now = Date.now();
  for (const r of records) {
    const [held] = await ctx.db.find(sourceRecords, { kind: r.kind, key: r.key, digest: r.digest });
    if (held) continue;
    await ctx.db.insert(sourceRecords, { tenantId, kind: r.kind, key: r.key, digest: r.digest, record: r.record, importedAt: now });
    added++;
  }
  return added;
}

/** Order states in which fulfillment has been accepted (the clock has started). */
const IN_FULFILLMENT = new Set(["accepted_for_fulfillment", "reviewing", "in_review", "delivered", "correcting"]);

export function requireFulfillment(order: { status: string }) {
  if (!IN_FULFILLMENT.has(order.status)) fail("FAILED_PRECONDITION", `The order is ${order.status}: it has not been accepted for fulfillment.`, { hint: "NOT_IN_FULFILLMENT" });
}

/** The order's customer-blocked intervals, from its append-only start/end events. */
export async function blockedIntervals(ctx: QueryCtx | MutationCtx, orderId: string): Promise<BlockedInterval[]> {
  const events = (await ctx.db.find(blockEvents, { orderId })).sort((a, b) => a.at - b.at || (a.kind === "start" ? -1 : 1));
  const intervals: BlockedInterval[] = [];
  let open: number | null = null;
  for (const e of events) {
    if (e.kind === "start" && open === null) open = e.at;
    else if (e.kind === "end" && open !== null) {
      intervals.push({ from: open, to: e.at });
      open = null;
    }
  }
  if (open !== null) intervals.push({ from: open, to: null });
  return intervals;
}

/** The order's turnaround deadline now, per the contract. */
export async function deadlineOf(ctx: QueryCtx | MutationCtx, order: { id: string; clockStartedAt?: number; timeZone: string }, now: number) {
  if (order.clockStartedAt === undefined) return { deadline: null, deadlineDate: null, paused: true, blockedBusinessDays: 0, blockedLimitReached: false };
  return turnaroundDeadline({
    start: order.clockStartedAt,
    timeZone: order.timeZone,
    businessDays: CONTRACT.service.turnaroundBusinessDays,
    blocked: await blockedIntervals(ctx, order.id),
    blockedLimitBusinessDays: CONTRACT.service.blockedLimitBusinessDays,
    now,
  });
}
