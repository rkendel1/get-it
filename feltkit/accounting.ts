/**
 * The accounting boundary, as a callable surface. Asking get-it to create, approve, post, pay, void,
 * send or delete an accounting record is always refused with ACCOUNTING_MUTATION_REFUSED, whoever
 * asks. Nothing is written.
 */
import { fail, s } from "@feltdb/feltkit";
import { AccountingMutationRefused, refuseAccountingAction } from "../src/accounting.js";
import { app } from "./app.js";
import { requireTenant } from "./_guards.js";

export const request = app.mutation({
  access: "accounting.request",
  args: { action: s.string({ minLength: 1, maxLength: 100 }), billKey: s.optional(s.string()) },
  handler: async (ctx, a) => {
    requireTenant(ctx);
    try {
      refuseAccountingAction(a.action);
    } catch (e) {
      if (e instanceof AccountingMutationRefused) fail("FORBIDDEN", e.message, { hint: e.code });
      throw e;
    }
  },
});
