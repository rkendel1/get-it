/**
 * The accounting boundary of `svc_bill_review_payable_prep@1.0.0`: get-it never creates, updates,
 * approves, posts, pays, voids, sends or deletes an accounting record.
 *
 * Enforced in four places:
 * 1. **No writer exists.** get-it holds no accounting credential, reads no accounting system, and
 *    has no code that writes one.
 * 2. **Refusal.** Any accounting action that is asked for, through `refuseAccountingAction()` or the
 *    app's `accounting.request` function, is refused with ACCOUNTING_MUTATION_REFUSED. Nothing is
 *    written.
 * 3. **Function inventory.** A test fixes the app's function list, so adding a function is a
 *    reviewed change.
 * 4. **Acceptance.** `no_accounting_mutation` requires every recommendation to be advisory and every
 *    input record to still match its digest.
 */

/** Every accounting action a caller might ask for. All are refused. */
export const ACCOUNTING_ACTIONS = [
  "bill.create",
  "bill.update",
  "bill.approve",
  "bill.post",
  "bill.pay",
  "bill.void",
  "bill.delete",
  "bill.send",
  "payment.record",
  "payment.schedule",
  "journal.post",
  "journal.reverse",
  "vendor.update",
  "account.update",
  "email.send",
] as const;

export class AccountingMutationRefused extends Error {
  readonly code = "ACCOUNTING_MUTATION_REFUSED";
  readonly action: string;
  constructor(action: string) {
    super(`${action} refused: this service never creates, updates, approves, posts, pays, voids, sends or deletes accounting records`);
    this.name = "AccountingMutationRefused";
    this.action = action;
  }
}

/** Refuse an accounting action: always. */
export function refuseAccountingAction(action: string): never {
  throw new AccountingMutationRefused(action);
}
