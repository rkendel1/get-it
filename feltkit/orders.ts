/**
 * Orders: an operator opens one per review, bound to the frozen contract and its review scope.
 * Intake, quoting and payment come later (spec §27); in this slice the operator binds the scope
 * directly.
 *
 * Customer-blocked time: the operator records when the order is blocked pending customer input and
 * when it is unblocked. Blocked business days do not count toward the turnaround. Ten of them reach
 * the contract's cancel-or-re-quote limit.
 */
import { fail, s } from "@feltdb/feltkit";
import { isCalendarDate } from "../src/bills.js";
import { assertTimeZone } from "../src/calendar.js";
import { app, audit, blockEvents, orders } from "./app.js";
import { CONTRACT, blockedIntervals, deadlineOf, requireTenant } from "./_guards.js";

export const create = app.mutation({
  access: "orders.write",
  args: {
    homeCurrency: s.optional(s.string({ pattern: "^[A-Z]{3}$" })),
    timeZone: s.string(),
    asOfDate: s.string(),
    documentRequiredOverMinor: s.optional(s.integer()),
    dueSoonBusinessDays: s.optional(s.integer()),
  },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    try {
      assertTimeZone(a.timeZone);
    } catch {
      fail("INVALID_ARGUMENT", `Unknown time zone ${a.timeZone}.`);
    }
    if (!isCalendarDate(a.asOfDate)) fail("INVALID_ARGUMENT", "asOfDate must be a calendar date (YYYY-MM-DD).");
    const d = CONTRACT.policyDefaults;
    const policy = {
      documentRequiredOverMinor: a.documentRequiredOverMinor ?? d.documentRequiredOverMinor.default,
      dueSoonBusinessDays: a.dueSoonBusinessDays ?? d.dueSoonBusinessDays.default,
    };
    if (policy.documentRequiredOverMinor < d.documentRequiredOverMinor.min || policy.documentRequiredOverMinor > d.documentRequiredOverMinor.max) fail("INVALID_ARGUMENT", "documentRequiredOverMinor is outside the contract's range.");
    if (policy.dueSoonBusinessDays < d.dueSoonBusinessDays.min || policy.dueSoonBusinessDays > d.dueSoonBusinessDays.max) fail("INVALID_ARGUMENT", "dueSoonBusinessDays is outside the contract's range.");
    const id = await ctx.db.insert(orders, {
      tenantId,
      contract: CONTRACT.key,
      contractDigest: CONTRACT.digest,
      homeCurrency: a.homeCurrency ?? "USD",
      timeZone: a.timeZone,
      asOfDate: a.asOfDate,
      policy,
      status: "intake",
      createdBy: ctx.auth.requirePrincipal().id,
      createdAt: Date.now(),
    });
    await audit.record(ctx, { subject: "order", id, type: "order.created", data: { contract: CONTRACT.key, contractDigest: CONTRACT.digest } });
    return id;
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
