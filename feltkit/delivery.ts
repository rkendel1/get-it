/**
 * Delivery, acceptance and correction: the end of the stored-step execution.
 *
 * - **publish** (operator): only an approved packet, and only when every acceptance criterion except
 *   on_time passes. The report, the deadline it was measured against, and the correction window
 *   are recorded with the delivery.
 * - **accept** (customer owner, a person): in full, or partially by naming the bills accepted. The
 *   charge follows the contract's pricing on the bills counted or accepted.
 * - **requestCorrection** (customer owner, a person): within the correction window and before
 *   acceptance. The operator then re-reviews (with corrected inputs if the customer supplies them)
 *   and a new package needs a new approval.
 *
 * Nothing here touches an accounting record. Recommendations are advisory, and acceptance accepts
 * get-it's review, not a bill.
 */
import { fail, s } from "@feltdb/feltkit";
import { evaluate, publishable } from "../src/acceptance.js";
import { correctionWindowEnd } from "../src/calendar.js";
import { buildPackage } from "../src/deliverables.js";
import { charge } from "../src/pricing.js";
import type { ReviewOutput } from "../src/review.js";
import { acceptances, app, approvals, audit, corrections, deliveries, orders, packets, runs, snapshots } from "./app.js";
import { CONTRACT, deadlineOf, loadSnapshot, requirePerson, requireTenant } from "./_guards.js";

export const publish = app.mutation({
  access: "delivery.publish",
  args: { packetId: s.string() },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const packet = await ctx.db.get(packets, a.packetId);
    if (!packet) fail("NOT_FOUND", "No such packet.");
    const [existing] = await ctx.db.find(deliveries, { packetId: packet.id });
    if (existing) return { deliveryId: existing.id, status: "existing" as const };
    const [approval] = await ctx.db.find(approvals, { packetId: packet.id });
    if (!approval) fail("FAILED_PRECONDITION", "The packet has not been approved by a person.", { hint: "NOT_APPROVED" });
    const run = await ctx.db.get(runs, packet.runId);
    const order = run && (await ctx.db.get(orders, run.orderId));
    const snap = run && (await ctx.db.get(snapshots, run.snapshotId));
    if (!run || !order || !snap) fail("FAILED_PRECONDITION", "The packet's run, order or snapshot is missing.");

    const now = Date.now();
    const clock = await deadlineOf(ctx, order, now);
    if (clock.deadline === null) fail("FAILED_PRECONDITION", "The order is blocked pending customer input: unblock it before publishing.", { hint: "BLOCKED" });
    const output = run.output as ReviewOutput;
    const report = evaluate(
      {
        snapshot: await loadSnapshot(ctx, snap),
        output,
        files: buildPackage(output).files,
        approvals: (await ctx.db.find(approvals, { packetId: packet.id })).map((x) => ({ packetDigest: x.digest, approvedBy: x.approvedBy, approverType: x.approverType, requestedBy: x.requestedBy })),
        publishedAt: now,
        deadline: clock.deadline,
      },
      CONTRACT,
    );
    if (!publishable(report)) fail("FAILED_PRECONDITION", "An acceptance criterion fails: the package cannot be delivered.", { hint: "ACCEPTANCE_FAILED", report });

    const deliveryId = await ctx.db.insert(deliveries, {
      tenantId,
      orderId: order.id,
      runId: run.id,
      packetId: packet.id,
      packetDigest: packet.digest,
      approvalId: approval.id,
      report,
      publishedBy: ctx.auth.requirePrincipal().id,
      publishedAt: now,
      deadline: clock.deadline,
      onTime: report.on_time.length === 0,
      correctionWindowEndsAt: correctionWindowEnd(now, order.timeZone, CONTRACT.service.correctionWindowBusinessDays),
    });
    await ctx.db.patch(orders, order.id, { status: "delivered" });
    await audit.record(ctx, { subject: "delivery", id: deliveryId, type: "delivery.published", data: { packetDigest: packet.digest, onTime: report.on_time.length === 0 } });
    return { deliveryId, status: "published" as const, onTime: report.on_time.length === 0 };
  },
});

/** The delivered files, regenerated from the stored output and checked against the packet. */
export const files = app.query({
  access: "delivery.read",
  args: { deliveryId: s.string() },
  handler: async (ctx, a) => {
    const delivery = await ctx.db.get(deliveries, a.deliveryId);
    if (!delivery) return null;
    const run = await ctx.db.get(runs, delivery.runId);
    if (!run) fail("FAILED_PRECONDITION", "The delivery's run is missing.");
    const pkg = buildPackage(run.output as ReviewOutput);
    if (pkg.packetDigest !== delivery.packetDigest) fail("FAILED_PRECONDITION", "The stored output no longer produces the delivered packet. Run the integrity check.", { hint: "STALE" });
    return pkg.files;
  },
});

async function openDelivery(ctx: Parameters<typeof requireTenant>[0], deliveryId: string) {
  const delivery = await ctx.db.get(deliveries, deliveryId);
  if (!delivery) fail("NOT_FOUND", "No such delivery.");
  const [accepted] = await ctx.db.find(acceptances, { deliveryId: delivery.id });
  if (accepted) fail("CONFLICT", "This delivery has already been accepted.", { hint: "ALREADY_ACCEPTED" });
  const [corrected] = await ctx.db.find(corrections, { deliveryId: delivery.id });
  if (corrected) fail("FAILED_PRECONDITION", "A correction was requested for this delivery; it is superseded by the corrected delivery.", { hint: "CORRECTION_REQUESTED" });
  return delivery;
}

export const accept = app.mutation({
  access: "delivery.accept",
  args: { deliveryId: s.string(), scope: s.enum(["full", "partial"] as const), acceptedBills: s.optional(s.array(s.string())) },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const person = requirePerson(ctx);
    const delivery = await openDelivery(ctx, a.deliveryId);
    const run = await ctx.db.get(runs, delivery.runId);
    if (!run) fail("FAILED_PRECONDITION", "The delivery's run is missing.");
    const all = (run.output as ReviewOutput).results.map((r) => r.billKey);
    let accepted: string[];
    if (a.scope === "full") {
      if (a.acceptedBills?.length) fail("INVALID_ARGUMENT", "A full acceptance names no bills.");
      accepted = all;
    } else {
      accepted = [...new Set(a.acceptedBills ?? [])].sort();
      if (accepted.length === 0) fail("INVALID_ARGUMENT", "A partial acceptance names the bills accepted.");
      const unknown = accepted.filter((k) => !all.includes(k));
      if (unknown.length) fail("INVALID_ARGUMENT", `Not in this delivery: ${unknown.join(", ")}.`);
      if (accepted.length === all.length) fail("INVALID_ARGUMENT", "Every bill is named: accept in full.");
    }
    const c = a.scope === "full" ? charge({ kind: "accepted", billsCounted: all.length }, CONTRACT.pricing) : charge({ kind: "partial", customerAcceptedPortion: true, billsAccepted: accepted.length }, CONTRACT.pricing);
    const id = await ctx.db.insert(acceptances, {
      tenantId,
      deliveryId: delivery.id,
      scope: a.scope,
      acceptedBills: accepted,
      billsCounted: accepted.length,
      chargeMinor: c.minor,
      chargeBasis: c.basis,
      acceptedBy: person.id,
      acceptedAt: Date.now(),
    });
    await ctx.db.patch(orders, delivery.orderId, { status: "accepted" });
    await audit.record(ctx, { subject: "delivery", id: delivery.id, type: "delivery.accepted", data: { scope: a.scope, bills: accepted.length, chargeMinor: c.minor } });
    return { acceptanceId: id, chargeMinor: c.minor, billsCounted: accepted.length };
  },
});

export const requestCorrection = app.mutation({
  access: "delivery.correct",
  args: { deliveryId: s.string(), reason: s.string({ minLength: 1, maxLength: 2000 }) },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const person = requirePerson(ctx);
    const delivery = await openDelivery(ctx, a.deliveryId);
    if (Date.now() > delivery.correctionWindowEndsAt) fail("FAILED_PRECONDITION", "The correction window has closed.", { hint: "WINDOW_CLOSED" });
    const id = await ctx.db.insert(corrections, { tenantId, deliveryId: delivery.id, reason: a.reason, requestedBy: person.id, requestedAt: Date.now() });
    await ctx.db.patch(orders, delivery.orderId, { status: "correcting" });
    await audit.record(ctx, { subject: "delivery", id: delivery.id, type: "delivery.correction_requested", data: { reason: a.reason } });
    return id;
  },
});

export const get = app.query({
  access: "delivery.read",
  args: { id: s.string() },
  handler: async (ctx, a) => {
    const delivery = await ctx.db.get(deliveries, a.id);
    if (!delivery) return null;
    const [acceptance] = await ctx.db.find(acceptances, { deliveryId: delivery.id });
    const [correction] = await ctx.db.find(corrections, { deliveryId: delivery.id });
    return { delivery, acceptance: acceptance ?? null, correction: correction ?? null };
  },
});
