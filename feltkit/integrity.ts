/**
 * Integrity: recompute get-it's invariants from what is stored, and list every violation.
 *
 * Invariants:
 * - Every record carries an explicit `tenantId` equal to the tenant it is read in.
 * - Every input record's digest is the digest of its content.
 * - Every snapshot's digest is the digest of its scope and manifest.
 * - Every run's output and packet digests recompute, and its output recomputes from its snapshot
 *   under the frozen contract (the review is deterministic).
 * - Every packet's digest is its run's. Every approval names its packet's digest, by a person who
 *   did not request it.
 * - Every decision names a customer-decided exception of its run.
 * - Every intake completion recomputes from its answers and bill set, and its report matches its digest.
 * - Every quote's digest covers its terms, and its price is runPriceMinor of its bill count.
 * - Every quote acceptance and payment names its quote's digest; every payment is for the quoted amount.
 * - Every fulfillment acceptance follows a payment, and its order's clock started exactly then.
 * - Every delivery names an approved packet. Every acceptance names delivered bills and charges what
 *   the contract's pricing gives. Every correction was requested within its window.
 *
 * FeltDB has no write-once collections, so this check is how drift in append-only facts is detected.
 */
import { charge, runPriceMinor } from "../src/pricing.js";
import { completeness, type AnswerState } from "../src/intake.js";
import { digest } from "../src/canonical.js";
import { buildPackage } from "../src/deliverables.js";
import { review, type ReviewOutput } from "../src/review.js";
import { snapshotDigest, type ReviewScope } from "../src/snapshot.js";
import { acceptances, app, approvals, blockEvents, corrections, decisions, deliveries, fulfillmentAcceptances, inputBindings, intakeAnswers, intakeCompleteness, intakeSessions, orders, outcomeRequests, packets, payments, quoteAcceptances, quotes, runs, snapshots, sourceRecords } from "./app.js";
import { CONTRACT, loadRecords, loadSnapshot, requireTenant } from "./_guards.js";
import { quoteTerms } from "./quotes.js";

export const check = app.query({
  access: "integrity.read",
  args: {},
  handler: async (ctx) => {
    const tenantId = requireTenant(ctx);
    const problems: string[] = [];
    const all = {
      outcomeRequests: await ctx.db.find(outcomeRequests, {}),
      intakeSessions: await ctx.db.find(intakeSessions, {}),
      intakeAnswers: await ctx.db.find(intakeAnswers, {}),
      inputBindings: await ctx.db.find(inputBindings, {}),
      intakeCompleteness: await ctx.db.find(intakeCompleteness, {}),
      quotes: await ctx.db.find(quotes, {}),
      quoteAcceptances: await ctx.db.find(quoteAcceptances, {}),
      payments: await ctx.db.find(payments, {}),
      fulfillmentAcceptances: await ctx.db.find(fulfillmentAcceptances, {}),
      orders: await ctx.db.find(orders, {}),
      blockEvents: await ctx.db.find(blockEvents, {}),
      sourceRecords: await ctx.db.find(sourceRecords, {}),
      snapshots: await ctx.db.find(snapshots, {}),
      runs: await ctx.db.find(runs, {}),
      packets: await ctx.db.find(packets, {}),
      approvals: await ctx.db.find(approvals, {}),
      decisions: await ctx.db.find(decisions, {}),
      deliveries: await ctx.db.find(deliveries, {}),
      acceptances: await ctx.db.find(acceptances, {}),
      corrections: await ctx.db.find(corrections, {}),
    };
    for (const [name, list] of Object.entries(all)) {
      for (const r of list as Array<{ id: string; tenantId?: string }>) if (r.tenantId !== tenantId) problems.push(`${name} ${r.id}: tenantId ${String(r.tenantId)} ≠ ${tenantId}`);
    }

    for (const r of all.sourceRecords) if (digest(r.record) !== r.digest) problems.push(`input ${r.kind} ${r.key}: content does not match its digest`);

    const bindingById = new Map(all.inputBindings.map((x) => [x.id, x]));
    for (const c of all.intakeCompleteness) {
      if (digest(c.report) !== c.reportDigest) problems.push(`intake ${c.sessionId}: report does not match its digest`);
      const answers = new Map<string, AnswerState>();
      for (const r of all.intakeAnswers.filter((x) => x.sessionId === c.sessionId).sort((x, y) => x.answeredAt - y.answeredAt || (x.id < y.id ? -1 : 1))) answers.set(r.field, r.kind === "decline" ? { kind: "decline" } : { kind: "answer", value: r.value });
      const b = bindingById.get(c.billSetBindingId);
      if (!b) {
        problems.push(`intake ${c.sessionId}: bill-set binding missing`);
        continue;
      }
      if (c.contractDigest !== CONTRACT.digest) continue;
      try {
        const again = completeness(CONTRACT, answers, { manifest: b.manifest, records: await loadRecords(ctx, b.manifest, "The bill set"), digest: b.digest, counts: b.counts });
        if (digest(again.report) !== c.reportDigest) problems.push(`intake ${c.sessionId}: report does not recompute from its answers and bill set`);
      } catch (e) {
        problems.push(`intake ${c.sessionId}: cannot be recomputed (${(e as Error).message})`);
      }
    }
    const quoteById = new Map(all.quotes.map((x) => [x.id, x]));
    for (const q of all.quotes) {
      if (digest(quoteTerms(q)) !== q.digest) problems.push(`quote ${q.id}: content does not match its digest`);
      const price = runPriceMinor(q.billCount, CONTRACT.pricing);
      if (q.contractDigest === CONTRACT.digest && q.priceMinor !== price) problems.push(`quote ${q.id}: price ${q.priceMinor} is not runPriceMinor(${q.billCount}) = ${price}`);
    }
    for (const x of all.quoteAcceptances) if (quoteById.get(x.quoteId)?.digest !== x.quoteDigest) problems.push(`quote acceptance ${x.id}: does not name its quote's digest`);
    const paymentById = new Map(all.payments.map((x) => [x.id, x]));
    for (const p of all.payments) {
      const q = quoteById.get(p.quoteId);
      if (!q || q.digest !== p.quoteDigest || q.priceMinor !== p.amountMinor || q.currency !== p.currency) problems.push(`payment ${p.id}: does not match its quote`);
    }
    const fulfillmentByOrder = new Map(all.fulfillmentAcceptances.map((x) => [x.orderId, x]));
    for (const f of all.fulfillmentAcceptances) if (!paymentById.has(f.paymentId)) problems.push(`fulfillment acceptance ${f.id}: payment missing`);
    for (const o of all.orders) {
      const f = fulfillmentByOrder.get(o.id);
      if (o.clockStartedAt !== undefined && (!f || f.acceptedAt !== o.clockStartedAt)) problems.push(`order ${o.id}: clock started at ${o.clockStartedAt}, fulfillment was accepted at ${f ? f.acceptedAt : "never"}`);
    }
    const snapById = new Map(all.snapshots.map((x) => [x.id, x]));
    for (const snap of all.snapshots) if (snapshotDigest(snap.scope as ReviewScope, snap.manifest) !== snap.digest) problems.push(`snapshot ${snap.id}: digest does not recompute`);

    const runById = new Map(all.runs.map((x) => [x.id, x]));
    for (const run of all.runs) {
      const output = run.output as ReviewOutput;
      if (digest(output) !== run.outputDigest) problems.push(`run ${run.id}: output does not match its digest`);
      if (buildPackage(output).packetDigest !== run.packetDigest) problems.push(`run ${run.id}: packet digest does not recompute`);
      const snap = snapById.get(run.snapshotId);
      if (!snap) {
        problems.push(`run ${run.id}: snapshot ${run.snapshotId} missing`);
        continue;
      }
      if (run.contractDigest !== CONTRACT.digest) continue; // another contract version: not recomputable here
      try {
        if (digest(review(await loadSnapshot(ctx, snap), CONTRACT)) !== run.outputDigest) problems.push(`run ${run.id}: output does not recompute from its snapshot`);
      } catch (e) {
        problems.push(`run ${run.id}: snapshot cannot be re-reviewed (${(e as Error).message})`);
      }
    }

    const packetById = new Map(all.packets.map((x) => [x.id, x]));
    for (const p of all.packets) if (runById.get(p.runId)?.packetDigest !== p.digest) problems.push(`packet ${p.id}: digest is not its run's packet digest`);
    const approvalById = new Map(all.approvals.map((x) => [x.id, x]));
    for (const a of all.approvals) {
      const p = packetById.get(a.packetId);
      if (!p) problems.push(`approval ${a.id}: packet missing`);
      else if (a.digest !== p.digest) problems.push(`approval ${a.id}: approves ${a.digest}, the packet is ${p.digest}`);
      if (a.approvedBy === a.requestedBy) problems.push(`approval ${a.id}: approved by its requester`);
      if (a.approverType !== "user") problems.push(`approval ${a.id}: approver is not a person`);
    }
    for (const d of all.decisions) {
      const e = (runById.get(d.runId)?.output as ReviewOutput | undefined)?.exceptions.find((x) => x.id === d.exceptionId);
      if (!e) problems.push(`decision ${d.id}: exception ${d.exceptionId} not in its run`);
      else if (e.decision !== "customer") problems.push(`decision ${d.id}: ${e.type} is not a customer decision`);
    }

    const deliveryById = new Map(all.deliveries.map((x) => [x.id, x]));
    for (const d of all.deliveries) {
      const p = packetById.get(d.packetId);
      const a = approvalById.get(d.approvalId);
      if (!p || p.digest !== d.packetDigest) problems.push(`delivery ${d.id}: packet digest does not match`);
      if (!a || a.packetId !== d.packetId || a.digest !== d.packetDigest) problems.push(`delivery ${d.id}: not covered by an approval of its packet`);
      if (d.onTime !== d.publishedAt <= d.deadline) problems.push(`delivery ${d.id}: onTime does not agree with its deadline`);
    }
    for (const x of all.acceptances) {
      const d = deliveryById.get(x.deliveryId);
      const bills = new Set(((d && runById.get(d.runId)?.output) as ReviewOutput | undefined)?.results.map((r) => r.billKey) ?? []);
      if (!d) problems.push(`acceptance ${x.id}: delivery missing`);
      else if (x.packetDigest !== d.packetDigest) problems.push(`acceptance ${x.id}: names ${x.packetDigest}, the delivery is ${d.packetDigest}`);
      if (x.acceptedBills.some((k) => !bills.has(k)) || x.acceptedBills.length !== x.billsCounted) problems.push(`acceptance ${x.id}: accepted bills are not the delivery's`);
      const expected = x.scope === "full" ? charge({ kind: "accepted", billsCounted: x.billsCounted }, CONTRACT.pricing) : charge({ kind: "partial", customerAcceptedPortion: true, billsAccepted: x.billsCounted }, CONTRACT.pricing);
      if (expected.minor !== x.chargeMinor) problems.push(`acceptance ${x.id}: charge ${x.chargeMinor} ≠ ${expected.minor} by the contract`);
    }
    for (const c of all.corrections) {
      const d = deliveryById.get(c.deliveryId);
      if (!d) problems.push(`correction ${c.id}: delivery missing`);
      else if (c.packetDigest !== d.packetDigest) problems.push(`correction ${c.id}: names ${c.packetDigest}, the delivery is ${d.packetDigest}`);
      else if (c.requestedAt > d.correctionWindowEndsAt) problems.push(`correction ${c.id}: requested after the window`);
    }

    return { problems, counts: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, (v as unknown[]).length])) };
  },
});
