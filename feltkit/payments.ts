/**
 * Operator-recorded payment. No payment provider is integrated: an operator, who must be a person,
 * records a payment the customer made to get-it (bank transfer, check, …) for an accepted quote.
 *
 * This is the customer paying get-it for the service. It is not an accounting action on the
 * customer's books, which get-it never takes.
 *
 * - One payment per quote, for exactly the quoted amount and currency, bound to the quote digest.
 * - Recording again with the same idempotency key and terms returns the payment. Anything else for a
 *   paid quote is a conflict.
 * - Payment enables the order (`paid`) but does not accept it for fulfillment, and the clock does
 *   not start (orders.acceptForFulfillment).
 */
import { fail, s } from "@feltdb/feltkit";
import { app, audit, orders, payments, quoteAcceptances, quotes } from "./app.js";
import { requirePerson, requireTenant } from "./_guards.js";

export const record = app.mutation({
  access: "payments.record",
  args: {
    quoteId: s.string(),
    amountMinor: s.integer({ minimum: 0 }),
    currency: s.string({ pattern: "^[A-Z]{3}$" }),
    method: s.enum(["bank_transfer", "check", "card_offline", "cash", "other"] as const),
    reference: s.string({ minLength: 1, maxLength: 200 }),
    idempotencyKey: s.string({ minLength: 1, maxLength: 200 }),
  },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const person = requirePerson(ctx);
    const quote = await ctx.db.get(quotes, a.quoteId);
    if (!quote) fail("NOT_FOUND", "No such quote.");
    const [acceptance] = await ctx.db.find(quoteAcceptances, { quoteId: quote.id });
    if (!acceptance) fail("FAILED_PRECONDITION", "The quote has not been accepted by the customer.", { hint: "QUOTE_NOT_ACCEPTED" });

    const [paid] = await ctx.db.find(payments, { quoteId: quote.id });
    if (paid) {
      const same = paid.idempotencyKey === a.idempotencyKey && paid.amountMinor === a.amountMinor && paid.currency === a.currency && paid.method === a.method && paid.reference === a.reference;
      if (same) return { status: "existing" as const, paymentId: paid.id, orderId: paid.orderId };
      fail("CONFLICT", "A payment is already recorded for this quote.", { hint: "ALREADY_PAID" });
    }
    if (a.amountMinor !== quote.priceMinor || a.currency !== quote.currency) fail("INVALID_ARGUMENT", `The quote is ${quote.priceMinor} ${quote.currency}; a payment for another amount is not recorded.`, { hint: "AMOUNT_MISMATCH" });
    const [keyUsed] = await ctx.db.find(payments, { idempotencyKey: a.idempotencyKey });
    if (keyUsed) fail("CONFLICT", "That idempotency key was used for another payment.", { hint: "KEY_REUSED" });

    const order = await ctx.db.get(orders, acceptance.orderId);
    if (!order) fail("FAILED_PRECONDITION", "The quote's order is missing.");
    const paymentId = await ctx.db.insert(payments, {
      tenantId,
      quoteId: quote.id,
      quoteDigest: quote.digest,
      orderId: order.id,
      amountMinor: a.amountMinor,
      currency: a.currency,
      method: a.method,
      reference: a.reference,
      idempotencyKey: a.idempotencyKey,
      recordedBy: person.id,
      recordedAt: Date.now(),
    });
    if (order.status === "awaiting_payment") await ctx.db.patch(orders, order.id, { status: "paid" });
    await audit.record(ctx, { subject: "payment", id: paymentId, type: "payment.recorded", data: { quoteId: quote.id, amountMinor: a.amountMinor, currency: a.currency, method: a.method } });
    return { status: "recorded" as const, paymentId, orderId: order.id };
  },
});
