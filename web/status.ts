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
