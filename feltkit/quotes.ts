/**
 * Quotes: the frozen contract's price for a completed intake.
 *
 * - A quote is created once per completed intake and never changed. Its `digest` covers every
 *   commercial term (contract, bill count, price, currency, pricing, assumptions, turnaround,
 *   validity), and the integrity check recomputes both the digest and the price.
 * - Acceptance is by the customer's owner, a person, for the exact quote digest, before it expires.
 *   It is idempotent: accepting again returns the same acceptance and order.
 * - Acceptance creates the order, bound to the intake's answers. It does not record the bill set for
 *   the order or start fulfillment: payment and an explicit acceptance for fulfillment come first.
 */
import { fail, s, type MutationCtx } from "@feltdb/feltkit";
import { digest } from "../src/canonical.js";
import type { ReviewBindings } from "../src/intake.js";
import { runPriceMinor } from "../src/pricing.js";
import { app, audit, intakeCompleteness, orders, quoteAcceptances, quotes } from "./app.js";
import { CONTRACT, requirePerson, requireTenant } from "./_guards.js";

/** How long a quote may be accepted. An operating term recorded on every quote, not a contract term. */
export const QUOTE_VALIDITY_MS = 14 * 86_400_000;

/** The commercial terms a quote digest covers. */
export function quoteTerms(q: { completenessId: string; reportDigest: string; contract: string; contractDigest: string; billCount: number; priceMinor: number; currency: string; pricing: unknown; assumptions: unknown; turnaroundBusinessDays: number; validUntil: number }) {
  const { completenessId, reportDigest, contract, contractDigest, billCount, priceMinor, currency, pricing, assumptions, turnaroundBusinessDays, validUntil } = q;
  return { kind: "get-it.quote/1", completenessId, reportDigest, contract, contractDigest, billCount, priceMinor, currency, pricing, assumptions, turnaroundBusinessDays, validUntil };
}

export const create = app.mutation({
  access: "quotes.write",
  args: { sessionId: s.string() },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const [done] = await ctx.db.find(intakeCompleteness, { sessionId: a.sessionId });
    if (!done) fail("FAILED_PRECONDITION", "The intake is not complete: quote a completed intake.", { hint: "INTAKE_INCOMPLETE" });
    if (done.contractDigest !== CONTRACT.digest) fail("FAILED_PRECONDITION", `The intake was completed under ${done.contract} ${done.contractDigest}; this deployment runs ${CONTRACT.key}.`);
    const [existing] = await ctx.db.find(quotes, { completenessId: done.id });
    if (existing) return { status: "existing" as const, quoteId: existing.id, quoteDigest: existing.digest, billCount: existing.billCount, priceMinor: existing.priceMinor, currency: existing.currency };
    const now = Date.now();
    const terms = quoteTerms({
      completenessId: done.id,
      reportDigest: done.reportDigest,
      contract: CONTRACT.key,
      contractDigest: CONTRACT.digest,
      billCount: done.bills,
      priceMinor: runPriceMinor(done.bills, CONTRACT.pricing),
      currency: CONTRACT.contract.commercial.currency,
      pricing: { ...CONTRACT.pricing },
      assumptions: done.assumptions,
      turnaroundBusinessDays: CONTRACT.service.turnaroundBusinessDays,
      validUntil: now + QUOTE_VALIDITY_MS,
    });
    const quoteDigest = digest(terms);
    const { kind: _kind, ...fields } = terms;
    const quoteId = await ctx.db.insert(quotes, { tenantId, sessionId: done.sessionId, ...fields, pricing: { ...CONTRACT.pricing }, assumptions: done.assumptions.map((x) => ({ ...x })), digest: quoteDigest, createdBy: ctx.auth.requirePrincipal().id, createdAt: now });
    await audit.record(ctx, { subject: "quote", id: quoteId, type: "quote.created", data: { quoteDigest, billCount: terms.billCount, priceMinor: terms.priceMinor } });
    return { status: "created" as const, quoteId, quoteDigest, billCount: terms.billCount, priceMinor: terms.priceMinor, currency: terms.currency };
  },
});

export const get = app.query({
  access: "quotes.read",
  args: { id: s.string() },
  handler: async (ctx, a) => {
    const quote = await ctx.db.get(quotes, a.id);
    if (!quote) return null;
    const [acceptance] = await ctx.db.find(quoteAcceptances, { quoteId: quote.id });
    const { createdBy: _createdBy, ...visible } = quote;
    return { ...visible, acceptance: acceptance ? { orderId: acceptance.orderId, acceptedAt: acceptance.acceptedAt } : null };
  },
});

async function createOrder(ctx: MutationCtx, tenantId: string, quote: { id: string; sessionId: string; completenessId: string }, now: number): Promise<string> {
  const done = await ctx.db.get(intakeCompleteness, quote.completenessId);
  if (!done) fail("FAILED_PRECONDITION", "The quote's intake is missing.");
  const b = done.bindings as ReviewBindings;
  const orderId = await ctx.db.insert(orders, {
    tenantId,
    quoteId: quote.id,
    sessionId: quote.sessionId,
    completenessId: done.id,
    contract: CONTRACT.key,
    contractDigest: CONTRACT.digest,
    homeCurrency: b.homeCurrency,
    timeZone: b.timeZone,
    asOfDate: b.asOfDate,
    policy: { ...b.policy },
    status: "awaiting_payment",
    createdBy: ctx.auth.requirePrincipal().id,
    createdAt: now,
  });
  return orderId;
}

export const accept = app.mutation({
  access: "quotes.accept",
  args: { quoteId: s.string(), quoteDigest: s.string() },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const person = requirePerson(ctx);
    const quote = await ctx.db.get(quotes, a.quoteId);
    if (!quote) fail("NOT_FOUND", "No such quote.");
    if (a.quoteDigest !== quote.digest) fail("FAILED_PRECONDITION", "That is not this quote: its digest differs.", { hint: "DIGEST_MISMATCH" });
    const [existing] = await ctx.db.find(quoteAcceptances, { quoteId: quote.id });
    if (existing) return { status: "existing" as const, acceptanceId: existing.id, orderId: existing.orderId };
    if (digest(quoteTerms(quote)) !== quote.digest) fail("FAILED_PRECONDITION", "The quote no longer matches its digest. Run the integrity check.", { hint: "STALE" });
    const now = Date.now();
    if (now > quote.validUntil) fail("FAILED_PRECONDITION", "This quote has expired. Ask for a new quote.", { hint: "QUOTE_EXPIRED" });
    const orderId = await createOrder(ctx, tenantId, quote, now);
    const acceptanceId = await ctx.db.insert(quoteAcceptances, { tenantId, quoteId: quote.id, quoteDigest: quote.digest, orderId, acceptedBy: person.id, acceptedAt: now });
    await audit.record(ctx, { subject: "quote", id: quote.id, type: "quote.accepted", data: { quoteDigest: quote.digest, orderId } });
    await audit.record(ctx, { subject: "order", id: orderId, type: "order.created", data: { quoteId: quote.id, contract: CONTRACT.key, contractDigest: CONTRACT.digest } });
    return { status: "accepted" as const, acceptanceId, orderId };
  },
});

