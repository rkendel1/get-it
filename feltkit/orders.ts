/**
 * Orders. An order is created when the customer accepts a quote (quotes.ts) and is enabled by an
 * operator-recorded payment (payments.ts). Only `acceptForFulfillment` starts the turnaround clock,
 * and only once payment, complete inputs, the authority the contract requires, and the contract
 * digest are verified.
 *
 * The contract says the turnaround starts "when the first complete bill set is recorded for the
 * order". Acceptance for fulfillment is exactly that moment: it records the intake's bill set as the
 * order's first snapshot and starts the clock in the same transaction.
 *
 * Customer-blocked time: the operator records when the order is blocked pending customer input and
 * when it is unblocked. Blocked business days do not count toward the turnaround. Ten of them reach
 * the contract's cancel-or-re-quote limit.
 */
import { fail, s } from "@feltdb/feltkit";
import { snapshotDigest } from "../src/snapshot.js";
import { app, audit, blockEvents, fulfillmentAcceptances, inputBindings, intakeCompleteness, orders, payments, quotes, snapshots } from "./app.js";
import { CONTRACT, blockedIntervals, deadlineOf, requirePerson, requireTenant } from "./_guards.js";

/** Delegated grants a contract requires before fulfillment. This contract reads no external system and declares none. */
export function requiredGrants(contract: typeof CONTRACT): string[] {
  const requirements = (contract.contract as { requirements?: Array<{ kind?: string; id: string }> }).requirements ?? [];
  return requirements.filter((r) => r.kind === "grant").map((r) => r.id);
}

export const acceptForFulfillment = app.mutation({
  access: "orders.accept",
  args: { orderId: s.string() },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const person = requirePerson(ctx);
    const order = await ctx.db.get(orders, a.orderId);
    if (!order) fail("NOT_FOUND", "No such order.");
    const [existing] = await ctx.db.find(fulfillmentAcceptances, { orderId: order.id });
    if (existing) return { status: "existing" as const, acceptanceId: existing.id, acceptedAt: existing.acceptedAt };

    if (order.contractDigest !== CONTRACT.digest) fail("FAILED_PRECONDITION", `The order is bound to ${order.contract} ${order.contractDigest}; this deployment runs ${CONTRACT.key} ${CONTRACT.digest}.`, { hint: "CONTRACT_MISMATCH" });
    const quote = await ctx.db.get(quotes, order.quoteId);
    const [payment] = await ctx.db.find(payments, { quoteId: order.quoteId });
    if (!quote || !payment) fail("FAILED_PRECONDITION", "No payment is recorded for the order's quote.", { hint: "NOT_PAID" });
    if (payment.quoteDigest !== quote.digest || payment.amountMinor !== quote.priceMinor || payment.currency !== quote.currency) fail("FAILED_PRECONDITION", "The recorded payment does not match the quote.", { hint: "NOT_PAID" });
    const done = await ctx.db.get(intakeCompleteness, order.completenessId);
    const binding = done && (await ctx.db.get(inputBindings, done.billSetBindingId));
    if (!done || !binding || done.contractDigest !== CONTRACT.digest) fail("FAILED_PRECONDITION", "The order's inputs are not complete.", { hint: "INPUTS_INCOMPLETE" });
    const grants = requiredGrants(CONTRACT);
    if (grants.length) fail("FAILED_PRECONDITION", `The contract requires grants this build cannot verify: ${grants.join(", ")}.`, { hint: "GRANTS_REQUIRED" });

    const acceptedAt = Date.now();
    // The first complete bill set recorded for the order: the intake's bill set under the order's scope.
    const scope = { homeCurrency: order.homeCurrency, timeZone: order.timeZone, asOfDate: order.asOfDate, policy: { ...order.policy } };
    await ctx.db.insert(snapshots, {
      tenantId,
      orderId: order.id,
      digest: snapshotDigest(scope, binding.manifest),
      scope,
      manifest: binding.manifest.map((m) => ({ ...m })),
      bills: binding.counts.bills,
      importedBy: person.id,
      importedAt: acceptedAt,
    });
    const acceptanceId = await ctx.db.insert(fulfillmentAcceptances, { tenantId, orderId: order.id, paymentId: payment.id, completenessId: done.id, contractDigest: CONTRACT.digest, grants, acceptedBy: person.id, acceptedAt });
    await ctx.db.patch(orders, order.id, { status: "accepted_for_fulfillment", clockStartedAt: acceptedAt });
    await audit.record(ctx, { subject: "order", id: order.id, type: "order.accepted_for_fulfillment", data: { paymentId: payment.id, contractDigest: CONTRACT.digest } });
    return { status: "accepted" as const, acceptanceId, acceptedAt };
  },
});

export const block = app.mutation({
  access: "orders.write",
  args: { orderId: s.string(), reason: s.string({ minLength: 1, maxLength: 500 }) },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const order = await ctx.db.get(orders, a.orderId);
    if (!order) fail("NOT_FOUND", "No such order.");
    const intervals = await blockedIntervals(ctx, order.id);
    if (intervals.some((i) => i.to === null)) fail("FAILED_PRECONDITION", "The order is already blocked.");
    await ctx.db.insert(blockEvents, { tenantId, orderId: order.id, kind: "start", at: Date.now(), reason: a.reason, by: ctx.auth.requirePrincipal().id });
    await audit.record(ctx, { subject: "order", id: order.id, type: "order.blocked", data: { reason: a.reason } });
  },
});

export const unblock = app.mutation({
  access: "orders.write",
  args: { orderId: s.string(), reason: s.string({ minLength: 1, maxLength: 500 }) },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const order = await ctx.db.get(orders, a.orderId);
    if (!order) fail("NOT_FOUND", "No such order.");
    const intervals = await blockedIntervals(ctx, order.id);
    if (!intervals.some((i) => i.to === null)) fail("FAILED_PRECONDITION", "The order is not blocked.");
    await ctx.db.insert(blockEvents, { tenantId, orderId: order.id, kind: "end", at: Date.now(), reason: a.reason, by: ctx.auth.requirePrincipal().id });
    await audit.record(ctx, { subject: "order", id: order.id, type: "order.unblocked", data: { reason: a.reason } });
  },
});

export const get = app.query({
  access: "orders.read",
  args: { id: s.string() },
  handler: async (ctx, a) => ctx.db.get(orders, a.id),
});

export const list = app.query({
  access: "orders.read",
  args: {},
  handler: async (ctx) => ctx.db.find(orders, {}),
});

/** The turnaround clock as of now: the deadline, or paused, and the blocked business days. */
export const clock = app.query({
  access: "orders.read",
  args: { id: s.string() },
  handler: async (ctx, a) => {
    const order = await ctx.db.get(orders, a.id);
    if (!order) return null;
    return deadlineOf(ctx, order, Date.now());
  },
});
