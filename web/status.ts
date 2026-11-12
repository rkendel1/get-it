/**
 * The customer-facing status of a request, derived only from persisted records: the intake's
 * completion, the quote, and the order's status as the server stored it. Nothing here guesses at
 * progress.
 */
export const ORDER_STATUS: Record<string, string> = {
  awaiting_payment: "Awaiting payment",
  paid: "Payment recorded",
  accepted_for_fulfillment: "Awaiting fulfillment",
  reviewing: "In progress",
  in_review: "Awaiting review",
  delivered: "Delivered",
  correcting: "Correction requested",
  delivery_accepted: "Accepted",
};

export function orderStatusLabel(r: { status?: string; complete?: boolean; quote?: { id: string } | null; orderStatus?: string | null }): string {
  if (r.orderStatus) return ORDER_STATUS[r.orderStatus] ?? r.orderStatus;
  if (r.quote) return "Awaiting quote acceptance";
  if (r.complete) return "Preparing your quote";
  return "Awaiting your information";
}

/** The stages a customer sees, each marked done only by a persisted fact. */
export function stages(s: { complete: boolean; quoted: boolean; ordered: boolean; status: string | null }) {
  const after = (statuses: string[]) => s.status !== null && statuses.includes(s.status);
  return [
    { id: "information", label: "Information", done: s.complete },
    { id: "quote", label: "Quote accepted", done: s.ordered },
    { id: "payment", label: "Payment recorded", done: after(["paid", "accepted_for_fulfillment", "reviewing", "in_review", "delivered", "correcting", "delivery_accepted"]) },
    { id: "fulfillment", label: "Fulfillment", done: after(["delivered", "correcting", "delivery_accepted"]) },
    { id: "accepted", label: "Accepted", done: after(["delivery_accepted"]) },
  ];
}

/** A task request's state, in the customer's words: what it is and what happens next. */
export const TASK_STATUS: Record<string, { label: string; next: string }> = {
  ready_to_scope: { label: "Submitted", next: "We've received your request. A person on our team reviews every request to work out what it needs and whether we can do it. You can add details, files or links in the meantime." },
  more_information_required: { label: "More information needed", next: "We need a few answers before we can tell you whether and how we can do this. The questions are below." },
  requires_manual_review: { label: "Under review", next: "A person on our team is reviewing your request. We'll tell you here what we can do, and what we need from you." },
  requires_external_provider: { label: "Needs an outside professional", next: "This needs a professional we would have to arrange. Nobody has been arranged yet; we'll tell you here whether we can, and on what terms, before anything is agreed." },
  not_currently_fulfillable: { label: "Not something we can do right now", next: "We can't take this on at the moment. The reason is below. Your request stays here, and nothing has been charged." },
  fulfillment_path_identified: { label: "We can offer a service for this", next: "One of our services fits this request. Review it below and choose whether to continue with it." },
  ready_to_quote: { label: "Ready to quote", next: "We have everything we need to prepare your quote." },
};

/** The status shown in the request list: the service transaction's once it exists, else the task's. */
export function requestLabel(r: { outcome: string; offer: { title: string } | null; transaction: { intakeComplete: boolean; quote: unknown; orderStatus: string | null } | null }): string {
  if (r.transaction) {
    if (r.transaction.orderStatus || r.transaction.quote) return orderStatusLabel({ complete: r.transaction.intakeComplete, quote: r.transaction.quote ? { id: "" } : null, orderStatus: r.transaction.orderStatus });
    return r.transaction.intakeComplete ? "Preparing your quote" : "Awaiting your information";
  }
  if (r.offer) return "Service available: your choice";
  return TASK_STATUS[r.outcome]?.label ?? "Submitted";
}
