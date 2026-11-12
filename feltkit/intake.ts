/**
 * Intake: what the customer asks for, the answers the contract needs, and the bill set.
 *
 * Every rule comes from the frozen contract through src/intake.ts, and the bill set goes through the
 * same validator as an order import (`addressBillSet`, which `buildSnapshot` uses). Answers,
 * bindings and the completion are append-only facts. Completing an intake creates no order and
 * starts no clock: a quote (quotes.ts), its acceptance, a payment and an explicit acceptance for
 * fulfillment come first.
 */
import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { BillSetError } from "../src/bills.js";
import { digest } from "../src/canonical.js";
import { completeness, inputSpecs, validateAnswer, type AnswerState } from "../src/intake.js";
import { addressBillSet, type AddressedBillSet } from "../src/snapshot.js";
import { app, audit, inputBindings, intakeAnswers, intakeCompleteness, intakeSessions, outcomeRequests, quoteAcceptances, quotes } from "./app.js";
import { CONTRACT, loadRecords, requireTenant, storeRecords } from "./_guards.js";

export const create = app.mutation({
  access: "intake.write",
  args: { request: s.string({ minLength: 1, maxLength: 4000 }) },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const by = ctx.auth.requirePrincipal().id;
    const now = Date.now();
    const outcomeRequestId = await ctx.db.insert(outcomeRequests, { tenantId, text: a.request, contract: CONTRACT.key, requestedBy: by, requestedAt: now });
    const sessionId = await ctx.db.insert(intakeSessions, { tenantId, outcomeRequestId, contract: CONTRACT.key, contractDigest: CONTRACT.digest, createdBy: by, createdAt: now });
    await audit.record(ctx, { subject: "intake", id: sessionId, type: "intake.created", data: { contract: CONTRACT.key } });
    return { sessionId, outcomeRequestId };
  },
});

async function openSession(ctx: QueryCtx | MutationCtx, sessionId: string) {
  const session = await ctx.db.get(intakeSessions, sessionId);
  if (!session) fail("NOT_FOUND", "No such intake.");
  if (session.contractDigest !== CONTRACT.digest) fail("FAILED_PRECONDITION", `This intake is for ${session.contract} ${session.contractDigest}; this deployment runs ${CONTRACT.key}.`);
  const [done] = await ctx.db.find(intakeCompleteness, { sessionId: session.id });
  return { session, done: done ?? null };
}

/** The latest answer per input, in answer order. */
async function answersOf(ctx: QueryCtx | MutationCtx, sessionId: string): Promise<Map<string, AnswerState>> {
  const rows = (await ctx.db.find(intakeAnswers, { sessionId })).sort((x, y) => x.answeredAt - y.answeredAt || (x.id < y.id ? -1 : 1));
  const latest = new Map<string, AnswerState>();
  for (const r of rows) latest.set(r.field, r.kind === "decline" ? { kind: "decline" } : { kind: "answer", value: r.value });
  return latest;
}

async function latestBinding(ctx: QueryCtx | MutationCtx, sessionId: string) {
  const rows = (await ctx.db.find(inputBindings, { sessionId })).sort((x, y) => x.boundAt - y.boundAt || (x.id < y.id ? -1 : 1));
  return rows.at(-1) ?? null;
}

async function addressedOf(ctx: QueryCtx | MutationCtx, binding: Awaited<ReturnType<typeof latestBinding>>): Promise<AddressedBillSet | null> {
  if (!binding) return null;
  return { manifest: binding.manifest, records: await loadRecords(ctx, binding.manifest, "The bill set"), digest: binding.digest, counts: binding.counts };
}

export const answer = app.mutation({
  access: "intake.write",
  args: { sessionId: s.string(), field: s.string({ minLength: 1, maxLength: 100 }), value: s.optional(s.unknown()), decline: s.optional(s.boolean()) },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const { session, done } = await openSession(ctx, a.sessionId);
    if (done) fail("FAILED_PRECONDITION", "This intake is complete; its answers are final.", { hint: "INTAKE_CLOSED" });
    const spec = inputSpecs(CONTRACT).find((x) => x.id === a.field);
    if (!spec) fail("INVALID_ARGUMENT", `${a.field} is not an input of ${CONTRACT.key}.`, { hint: "UNKNOWN_INPUT" });
    if (spec.source === "bill set") fail("INVALID_ARGUMENT", `${a.field} is part of the bill set: upload it with intake.uploadBillSet.`, { hint: "BILL_SET_INPUT" });
    const now = Date.now();
    const by = ctx.auth.requirePrincipal().id;
    if (a.decline) {
      if (a.value !== undefined) fail("INVALID_ARGUMENT", "Either answer or decline, not both.", { hint: "ANSWER_INVALID" });
      if (spec.required) fail("INVALID_ARGUMENT", `${a.field} is required by the contract and cannot be declined.`, { hint: "REQUIRED_INPUT" });
      await ctx.db.insert(intakeAnswers, { tenantId, sessionId: session.id, field: spec.id, kind: "decline", answeredBy: by, answeredAt: now });
      return { field: spec.id, status: "declined" as const };
    }
    const v = validateAnswer(spec, a.value);
    if (!v.ok) fail("INVALID_ARGUMENT", v.issue, { hint: "ANSWER_INVALID" });
    await ctx.db.insert(intakeAnswers, { tenantId, sessionId: session.id, field: spec.id, kind: "answer", value: v.value, answeredBy: by, answeredAt: now });
    return { field: spec.id, status: "answered" as const, value: v.value };
  },
});

export const uploadBillSet = app.mutation({
  access: "intake.write",
  args: { sessionId: s.string(), billSet: s.unknown() },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const { session, done } = await openSession(ctx, a.sessionId);
    if (done) fail("FAILED_PRECONDITION", "This intake is complete; its bill set is final.", { hint: "INTAKE_CLOSED" });
    let addressed: AddressedBillSet;
    try {
      addressed = addressBillSet(a.billSet, CONTRACT);
    } catch (e) {
      if (e instanceof BillSetError) fail("INVALID_ARGUMENT", e.message, { hint: "BILL_SET_INVALID", issues: e.issues });
      throw e;
    }
    const latest = await latestBinding(ctx, session.id);
    if (latest?.digest === addressed.digest) return { status: "duplicate" as const, bindingId: latest.id, digest: latest.digest, bills: latest.counts.bills, recordsAdded: 0 };
    const recordsAdded = await storeRecords(ctx, tenantId, addressed.records);
    const bindingId = await ctx.db.insert(inputBindings, {
      tenantId,
      sessionId: session.id,
      input: "billSet",
      digest: addressed.digest,
      manifest: addressed.manifest.map((m) => ({ ...m })),
      counts: { ...addressed.counts },
      boundBy: ctx.auth.requirePrincipal().id,
      boundAt: Date.now(),
    });
    await audit.record(ctx, { subject: "intake", id: session.id, type: "intake.bill_set_bound", data: { digest: addressed.digest, ...addressed.counts, recordsAdded } });
    return { status: "bound" as const, bindingId, digest: addressed.digest, bills: addressed.counts.bills, recordsAdded };
  },
});

export const complete = app.mutation({
  access: "intake.write",
  args: { sessionId: s.string() },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const { session, done } = await openSession(ctx, a.sessionId);
    if (done) return { status: "complete" as const, completenessId: done.id, reportDigest: done.reportDigest };
    const binding = await latestBinding(ctx, session.id);
    const c = completeness(CONTRACT, await answersOf(ctx, session.id), await addressedOf(ctx, binding));
    if (!c.complete || !binding) fail("FAILED_PRECONDITION", `Required inputs are missing: ${c.missing.join(", ")}.`, { hint: "INTAKE_INCOMPLETE", missing: c.missing });
    const reportDigest = digest(c.report);
    const completenessId = await ctx.db.insert(intakeCompleteness, {
      tenantId,
      sessionId: session.id,
      contract: CONTRACT.key,
      contractDigest: CONTRACT.digest,
      report: c.report,
      reportDigest,
      bindings: c.bindings,
      assumptions: c.assumptions.map((x) => ({ ...x })),
      billSetBindingId: binding.id,
      billSetDigest: binding.digest,
      bills: binding.counts.bills,
      completedBy: ctx.auth.requirePrincipal().id,
      completedAt: Date.now(),
    });
    await audit.record(ctx, { subject: "intake", id: session.id, type: "intake.completed", data: { reportDigest, assumptions: c.assumptions.length } });
    return { status: "complete" as const, completenessId, reportDigest };
  },
});

/** The intake as it stands: answers (latest per input), the bound bill set, the live completeness report, and its quote. */
export const get = app.query({
  access: "intake.read",
  args: { sessionId: s.string() },
  handler: async (ctx, a) => {
    requireTenant(ctx);
    const session = await ctx.db.get(intakeSessions, a.sessionId);
    if (!session) return null;
    const [done] = await ctx.db.find(intakeCompleteness, { sessionId: session.id });
    const request = await ctx.db.get(outcomeRequests, session.outcomeRequestId);
    const answers = await answersOf(ctx, session.id);
    const binding = await latestBinding(ctx, session.id);
    const live = completeness(CONTRACT, answers, await addressedOf(ctx, binding));
    // How the customer finds what they are offered: the quote for this intake, with the digest they accept.
    const [quote] = done ? await ctx.db.find(quotes, { completenessId: done.id }) : [];
    const [acceptance] = quote ? await ctx.db.find(quoteAcceptances, { quoteId: quote.id }) : [];
    return {
      session: { id: session.id, contract: session.contract, contractDigest: session.contractDigest, createdAt: session.createdAt },
      request: request?.text ?? null,
      answers: Object.fromEntries(answers),
      billSet: binding ? { digest: binding.digest, ...binding.counts } : null,
      completeness: done ? { status: "complete" as const, completenessId: done.id, report: done.report, reportDigest: done.reportDigest } : { status: "open" as const, missing: live.missing, report: live.report },
      quote: quote ? { id: quote.id, digest: quote.digest, billCount: quote.billCount, priceMinor: quote.priceMinor, currency: quote.currency, validUntil: quote.validUntil, orderId: acceptance?.orderId ?? null } : null,
    };
  },
});
