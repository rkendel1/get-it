/**
 * Review and decisions, per the frozen contract.
 *
 * - An operator requests review of one delivery packet. The packet is bound to the digest of
 *   (contract, snapshot, output).
 * - A different operator, who must be a person, approves that exact digest before the packet
 *   expires. A re-run produces a different packet; an approval never carries over.
 * - The customer's people decide the ambiguous business questions (exception types the contract
 *   marks `decision: customer`). A decision is recorded only. Nothing is written to QuickBooks.
 *
 * This is FeltKit's approval discipline (person-only, proposer ≠ approver, digest-bound, expiring,
 * re-checked when decided), applied to get-it's own records, as Ledger does with its proposals.
 */
import { fail, s } from "@feltdb/feltkit";
import { packetDigest, type ReconciliationOutput } from "../src/reconcile.js";
import { app, approvals, audit, decisions, orders, packets, runs } from "./app.js";
import { requirePerson, requireTenant } from "./_guards.js";

/** How long a review request stays approvable. An internal control, not a contract term. */
export const PACKET_TTL_MS = 7 * 86_400_000;

export const request = app.mutation({
  access: "review.request",
  args: { runId: s.string() },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const run = await ctx.db.get(runs, a.runId);
    if (!run) fail("NOT_FOUND", "No such run.");
    const digest = packetDigest(run.output as ReconciliationOutput);
    if (digest !== run.packetDigest) fail("FAILED_PRECONDITION", "The run's output no longer matches its recorded packet digest. Run the integrity check.");
    const [open] = await ctx.db.find(packets, { runId: run.id, digest });
    if (open) return { packetId: open.id, digest, status: "existing" as const };
    const now = Date.now();
    const output = run.output as ReconciliationOutput;
    const packetId = await ctx.db.insert(packets, {
      tenantId,
      orderId: run.orderId,
      runId: run.id,
      digest,
      requiringReview: output.summary.requiringReview,
      requestedBy: ctx.auth.requirePrincipal().id,
      requestedAt: now,
      expiresAt: now + PACKET_TTL_MS,
    });
    await ctx.db.patch(orders, run.orderId, { status: "in_review" });
    await audit.record(ctx, { subject: "packet", id: packetId, type: "packet.requested", data: { runId: run.id, digest } });
    return { packetId, digest, status: "requested" as const };
  },
});

export const approve = app.mutation({
  access: "review.approve",
  args: { packetId: s.string(), digest: s.string() },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const person = requirePerson(ctx);
    const packet = await ctx.db.get(packets, a.packetId);
    if (!packet) fail("NOT_FOUND", "No such packet.");
    if (a.digest !== packet.digest) fail("FAILED_PRECONDITION", "That is not the packet under review: its digest differs. Review the current packet.", { hint: "DIGEST_MISMATCH" });
    if (person.id === packet.requestedBy) fail("FORBIDDEN", "The operator who requested review cannot approve it.", { hint: "SELF_APPROVAL" });
    if (Date.now() > packet.expiresAt) fail("FAILED_PRECONDITION", "This review request has expired. Request review again.", { hint: "EXPIRED" });
    // Re-check what is being approved against the stored output now, not as it was when requested.
    const run = await ctx.db.get(runs, packet.runId);
    if (!run || packetDigest(run.output as ReconciliationOutput) !== packet.digest) fail("FAILED_PRECONDITION", "The packet no longer matches its run.", { hint: "STALE" });
    const [already] = await ctx.db.find(approvals, { packetId: packet.id });
    if (already) return { approvalId: already.id, status: "existing" as const };
    const approvalId = await ctx.db.insert(approvals, {
      tenantId,
      packetId: packet.id,
      digest: packet.digest,
      requestedBy: packet.requestedBy,
      approvedBy: person.id,
      approverType: person.type,
      approvedAt: Date.now(),
    });
    await audit.record(ctx, { subject: "packet", id: packet.id, type: "packet.approved", data: { digest: packet.digest, approvedBy: person.id } });
    return { approvalId, status: "approved" as const };
  },
});

export const decide = app.mutation({
  access: "decisions.record",
  args: { runId: s.string(), exceptionId: s.string(), decision: s.enum(["confirmed", "rejected", "acknowledged"] as const), note: s.optional(s.string({ maxLength: 2000 })) },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const person = requirePerson(ctx);
    const run = await ctx.db.get(runs, a.runId);
    if (!run) fail("NOT_FOUND", "No such run.");
    const exception = (run.output as ReconciliationOutput).exceptions.find((e) => e.id === a.exceptionId);
    if (!exception) fail("NOT_FOUND", "No such exception in this run.");
    if (exception.decision !== "customer") fail("FAILED_PRECONDITION", `${exception.type} is reviewed by the operator, not decided by the customer.`);
    const [existing] = await ctx.db.find(decisions, { runId: run.id, exceptionId: exception.id });
    if (existing) fail("CONFLICT", "This question has already been decided.");
    const id = await ctx.db.insert(decisions, {
      tenantId,
      runId: run.id,
      exceptionId: exception.id,
      decision: a.decision,
      ...(a.note ? { note: a.note } : {}),
      decidedBy: person.id,
      decidedAt: Date.now(),
    });
    await audit.record(ctx, { subject: "decision", id, type: "decision.recorded", data: { exceptionId: exception.id, decision: a.decision } });
    return id;
  },
});

export const listPackets = app.query({
  access: "review.read",
  args: { runId: s.string() },
  handler: async (ctx, a) => ctx.db.find(packets, { runId: a.runId }),
});

export const listApprovals = app.query({
  access: "review.read",
  args: { packetId: s.string() },
  handler: async (ctx, a) => ctx.db.find(approvals, { packetId: a.packetId }),
});
