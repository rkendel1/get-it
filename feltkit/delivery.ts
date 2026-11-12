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
 * - **view** and **download** (anyone in the organization with `delivery.read`): the customer's
 *   boundary. The view shows the order status, the delivered files, the acceptance criteria, the
 *   evidence references, the correction deadline and what is still unresolved, and no internal
 *   identities or records. A download is exactly one file the approval packet lists, regenerated
 *   from the stored output and checked against its sha256.
 *
 * Acceptance and correction name the delivered package's digest, so a customer acts on exactly what
 * they were shown. A correction is a record beside the delivery; the delivery itself never changes.
 *
 * Nothing here touches an accounting record. Recommendations are advisory, and acceptance accepts
 * get-it's review, not a bill.
 */
import { fail, s } from "@feltdb/feltkit";
import { evaluate, publishable } from "../src/acceptance.js";
import { correctionWindowEnd } from "../src/calendar.js";
import { buildPackage, PACKET_FILE, sha256Hex, type ApprovalPacket } from "../src/deliverables.js";
import { charge } from "../src/pricing.js";
import type { ReviewOutput } from "../src/review.js";
import { acceptances, app, approvals, audit, corrections, decisions, deliveries, orders, packets, quotes, runs, snapshots } from "./app.js";
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

async function openDelivery(ctx: Parameters<typeof requireTenant>[0], deliveryId: string, packetDigest: string) {
  const delivery = await ctx.db.get(deliveries, deliveryId);
  if (!delivery) fail("NOT_FOUND", "No such delivery.");
  if (packetDigest !== delivery.packetDigest) fail("FAILED_PRECONDITION", "That is not the delivered package: its digest differs.", { hint: "DIGEST_MISMATCH" });
  const [accepted] = await ctx.db.find(acceptances, { deliveryId: delivery.id });
  if (accepted) fail("CONFLICT", "This delivery has already been accepted.", { hint: "ALREADY_ACCEPTED" });
  const [corrected] = await ctx.db.find(corrections, { deliveryId: delivery.id });
  if (corrected) fail("FAILED_PRECONDITION", "A correction was requested for this delivery; it is superseded by the corrected delivery.", { hint: "CORRECTION_REQUESTED" });
  return delivery;
}

export const accept = app.mutation({
  access: "delivery.accept",
  args: { deliveryId: s.string(), packetDigest: s.string(), scope: s.enum(["full", "partial"] as const), acceptedBills: s.optional(s.array(s.string())) },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const person = requirePerson(ctx);
    const delivery = await openDelivery(ctx, a.deliveryId, a.packetDigest);
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
      packetDigest: delivery.packetDigest,
      scope: a.scope,
      acceptedBills: accepted,
      billsCounted: accepted.length,
      chargeMinor: c.minor,
      chargeBasis: c.basis,
      acceptedBy: person.id,
      acceptedAt: Date.now(),
    });
    await ctx.db.patch(orders, delivery.orderId, { status: "delivery_accepted" });
    await audit.record(ctx, { subject: "delivery", id: delivery.id, type: "delivery.accepted", data: { scope: a.scope, bills: accepted.length, chargeMinor: c.minor } });
    return { acceptanceId: id, chargeMinor: c.minor, billsCounted: accepted.length };
  },
});

export const requestCorrection = app.mutation({
  access: "delivery.correct",
  args: { deliveryId: s.string(), packetDigest: s.string(), reason: s.string({ minLength: 1, maxLength: 2000 }) },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const person = requirePerson(ctx);
    const delivery = await openDelivery(ctx, a.deliveryId, a.packetDigest);
    if (Date.now() > delivery.correctionWindowEndsAt) fail("FAILED_PRECONDITION", "The correction window has closed.", { hint: "WINDOW_CLOSED" });
    const id = await ctx.db.insert(corrections, { tenantId, deliveryId: delivery.id, packetDigest: delivery.packetDigest, reason: a.reason, requestedBy: person.id, requestedAt: Date.now() });
    await ctx.db.patch(orders, delivery.orderId, { status: "correcting" });
    await audit.record(ctx, { subject: "delivery", id: delivery.id, type: "delivery.correction_requested", data: { reason: a.reason } });
    return id;
  },
});

export const get = app.query({
  access: "delivery.read",
  args: { id: s.string() },
  handler: async (ctx, a) => {
    const found = await ctx.db.get(deliveries, a.id);
    if (!found) return null;
    const { publishedBy: _by, approvalId: _approval, ...delivery } = found; // no internal identities
    const [acceptance] = await ctx.db.find(acceptances, { deliveryId: delivery.id });
    const [correction] = await ctx.db.find(corrections, { deliveryId: delivery.id });
    // The customer's own records; the people who made them are customers, and are shown.
    return { delivery, acceptance: acceptance ?? null, correction: correction ?? null };
  },
});

/** Regenerate a delivery's package and refuse if it no longer matches what was delivered. */
async function deliveredPackage(ctx: Parameters<typeof requireTenant>[0], delivery: { runId: string; packetDigest: string }) {
  const run = await ctx.db.get(runs, delivery.runId);
  if (!run) fail("FAILED_PRECONDITION", "The delivery's run is missing.");
  const pkg = buildPackage(run.output as ReviewOutput);
  if (pkg.packetDigest !== delivery.packetDigest) fail("FAILED_PRECONDITION", "The stored output no longer produces the delivered packet. Run the integrity check.", { hint: "STALE" });
  return { run, pkg };
}

/** One delivered file: only a name the approval packet lists (or the packet itself), checked against its sha256. */
export const download = app.query({
  access: "delivery.read",
  args: { deliveryId: s.string(), name: s.string({ maxLength: 200 }) },
  handler: async (ctx, a) => {
    requireTenant(ctx);
    const delivery = await ctx.db.get(deliveries, a.deliveryId);
    if (!delivery) fail("NOT_FOUND", "No such delivery.");
    const { pkg } = await deliveredPackage(ctx, delivery);
    const listed = pkg.packet.files.find((f) => f.name === a.name);
    if (!listed && a.name !== PACKET_FILE) fail("NOT_FOUND", `${a.name || "(empty)"} is not a file of this delivery.`);
    const content = pkg.files[a.name]!;
    const sha256 = sha256Hex(content);
    if (listed && listed.sha256 !== sha256) fail("FAILED_PRECONDITION", `${a.name} does not match the approval packet.`, { hint: "STALE" });
    return { name: a.name, content, sha256, bytes: Buffer.byteLength(content, "utf8"), contentType: a.name.endsWith(".csv") ? "text/csv" : "application/json" };
  },
});

/**
 * The customer's view of an order: status, the latest delivery (files, acceptance criteria, evidence
 * references, correction deadline, acceptance or correction) and what is still unresolved. It exposes no
 * internal identities, approval records or run output.
 */
export const view = app.query({
  access: "delivery.read",
  args: { orderId: s.string() },
  handler: async (ctx, a) => {
    requireTenant(ctx);
    const order = await ctx.db.get(orders, a.orderId);
    if (!order) return null;
    const quote = await ctx.db.get(quotes, order.quoteId);
    const latest = (await ctx.db.find(deliveries, { orderId: order.id })).sort((x, y) => x.publishedAt - y.publishedAt).at(-1);
    let delivery = null;
    let unresolved = { customerDecisions: [] as string[], informationRequests: [] as Array<{ id: string; billKey: string; ask: string; blocking: boolean }> };
    if (latest) {
      const { run, pkg } = await deliveredPackage(ctx, latest);
      const output = run.output as ReviewOutput;
      const packet = JSON.parse(pkg.files[PACKET_FILE]!) as ApprovalPacket;
      const report = latest.report as Record<string, string[]>;
      const [acceptance] = await ctx.db.find(acceptances, { deliveryId: latest.id });
      const [correction] = await ctx.db.find(corrections, { deliveryId: latest.id });
      const decided = new Set((await ctx.db.find(decisions, { runId: run.id })).map((d) => d.exceptionId));
      delivery = {
        id: latest.id,
        packetDigest: latest.packetDigest,
        publishedAt: latest.publishedAt,
        deadline: latest.deadline,
        onTime: latest.onTime,
        correctionWindowEndsAt: latest.correctionWindowEndsAt,
        files: [{ name: PACKET_FILE, sha256: sha256Hex(pkg.files[PACKET_FILE]!), bytes: Buffer.byteLength(pkg.files[PACKET_FILE]!, "utf8") }, ...packet.files].sort((x, y) => (x.name < y.name ? -1 : 1)),
        summary: output.summary,
        acceptanceCriteria: Object.fromEntries(CONTRACT.contract.acceptanceCriteria.map((c) => [c.id, (report[c.id] ?? []).length === 0 ? "passed" : "failed"])),
        evidence: { file: "evidence.json", snapshotDigest: output.snapshotDigest, outputDigest: packet.outputDigest, inputs: output.results.map((r) => ({ bill: r.billKey, digest: r.source.digest })) },
        acceptance: acceptance ? { scope: acceptance.scope, acceptedBills: acceptance.acceptedBills, chargeMinor: acceptance.chargeMinor, acceptedAt: acceptance.acceptedAt } : null,
        correction: correction ? { reason: correction.reason, requestedAt: correction.requestedAt } : null,
      };
      unresolved = {
        customerDecisions: output.exceptions.filter((e) => e.decision === "customer" && !decided.has(e.id)).map((e) => e.id),
        informationRequests: output.requests.map((r) => ({ id: r.id, billKey: r.billKey, ask: r.ask, blocking: r.blocking })),
      };
    }
    return {
      order: { id: order.id, status: order.status, contract: order.contract, contractDigest: order.contractDigest, asOfDate: order.asOfDate, homeCurrency: order.homeCurrency, timeZone: order.timeZone, priceMinor: quote?.priceMinor ?? null, currency: quote?.currency ?? null },
      clock: await deadlineOf(ctx, order, Date.now()),
      delivery,
      unresolved,
    };
  },
});
