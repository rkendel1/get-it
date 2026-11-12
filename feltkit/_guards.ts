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
  orderId: string;
  digest: string;
  scope: unknown;
  manifest: Array<{ kind: SourceKind; key: string; digest: string }>;
}

/** Rebuild a stored snapshot from its manifest and the content-addressed source records. */
export async function loadSnapshot(ctx: QueryCtx | MutationCtx, snap: StoredSnapshot): Promise<Snapshot> {
  const stored = await ctx.db.find(sourceRecords, { orderId: snap.orderId });
  const byKey = new Map(stored.map((r) => [`${r.kind}:${r.key}:${r.digest}`, r.record]));
  const records = snap.manifest.map((m) => {
    const record = byKey.get(`${m.kind}:${m.key}:${m.digest}`);
    if (record === undefined) fail("FAILED_PRECONDITION", `Snapshot ${snap.digest} names ${m.kind} ${m.key}, which is not stored.`);
    return { ...m, record };
  });
  return { scope: snap.scope as ReviewScope, manifest: snap.manifest, digest: snap.digest, records };
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
