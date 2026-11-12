/**
 * Orders: an operator opens one per reconciliation, bound to the frozen contract.
 *
 * Intake, quoting and payment come later (spec §27). Phase 0 binds the inputs directly.
 */
import { fail, s } from "@feltdb/feltkit";
import { assertTimeZone } from "../src/calendar.js";
import { app, audit, orders } from "./app.js";
import { CONTRACT, requireTenant } from "./_guards.js";

export const create = app.mutation({
  access: "orders.write",
  args: {
    realmId: s.string({ pattern: "^\\d+$" }),
    from: s.string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    to: s.string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    vendorIds: s.optional(s.array(s.string())),
    homeCurrency: s.optional(s.string({ pattern: "^[A-Z]{3}$" })),
    timeZone: s.string(),
  },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    if (a.from > a.to) fail("INVALID_ARGUMENT", "The period ends before it starts.");
    try {
      assertTimeZone(a.timeZone);
    } catch {
      fail("INVALID_ARGUMENT", `Unknown time zone ${a.timeZone}.`);
    }
    const id = await ctx.db.insert(orders, {
      tenantId,
      contract: CONTRACT.key,
      contractDigest: CONTRACT.digest,
      realmId: a.realmId,
      from: a.from,
      to: a.to,
      vendorIds: [...new Set(a.vendorIds ?? [])].sort(),
      homeCurrency: a.homeCurrency ?? "USD",
      timeZone: a.timeZone,
      status: "intake",
      createdBy: ctx.auth.requirePrincipal().id,
      createdAt: Date.now(),
    });
    await audit.record(ctx, { subject: "order", id, type: "order.created", data: { contract: CONTRACT.key, contractDigest: CONTRACT.digest } });
    return id;
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
