/**
 * The accounting boundary in the domain: every accounting action is refused, whatever its name.
 * (The app-level refusal and the function inventory are in app.test.ts.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNTING_ACTIONS, AccountingMutationRefused, refuseAccountingAction } from "../src/accounting.js";

test("every accounting action is refused", () => {
  assert.deepEqual([...ACCOUNTING_ACTIONS], ["bill.create", "bill.update", "bill.approve", "bill.post", "bill.pay", "bill.void", "bill.delete", "bill.send", "payment.record", "payment.schedule", "journal.post", "journal.reverse", "vendor.update", "account.update", "email.send"]);
  for (const action of [...ACCOUNTING_ACTIONS, "anything.else"]) {
    assert.throws(() => refuseAccountingAction(action), (e: unknown) => e instanceof AccountingMutationRefused && e.code === "ACCOUNTING_MUTATION_REFUSED" && e.action === action);
  }
});
