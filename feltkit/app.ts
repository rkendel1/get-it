/**
 * get-it on FeltKit.
 *
 * First outcome: `svc_bill_review_payable_prep@1.0.0`. The customer submits a Ledger-compatible
 * bill set; get-it reviews it and delivers an approved review package. get-it reads no accounting
 * system and writes no accounting record (src/accounting.ts).
 *
 * Tenancy: FeltKit's in-store tenant model. Each customer organization is a FeltKit tenant
 * (`auth.tenant`). get-it's staff work in it as members with the `operator` role.
 * - Every collection is `{ tenant: true }`: FeltKit limits every read and write to the caller's live
 *   tenant and refuses a write naming another one.
 * - Every collection also declares `tenantId` as a **required** field, which get-it sets explicitly
 *   from the session's tenant (`requireTenant`). The typechecker refuses an insert without it.
 * - Every unique constraint includes `tenantId`.
 * - The integrity check verifies `tenantId` on every record.
 *
 * Facts are append-only. Every collection except `orders` (whose `status` and `clockStartedAt` are a
 * projection of its facts: payments, fulfillment acceptance, runs, deliveries…) is written with
 * `insert` only. The integrity check recomputes digests to
 * detect drift; FeltDB has no write-once collections.
 *
 * Execution is stored steps, with no workflow runtime:
 * intake → quote → accept quote (order) → record payment → accept for fulfillment (clock starts)
 * → review → request → approve → publish → accept or correct. Each step is a mutation committing one fact.
 */
import { feltkit, s } from "@feltdb/feltkit";

const READ = ["intake.read", "quotes.read", "payments.read", "orders.read", "imports.read", "runs.read", "review.read", "decisions.read", "delivery.read", "integrity.read"];

/** Anyone in an organization may ask for an accounting action. It is always refused (accounting.ts). */
const ASK = ["accounting.request"];

/** Customer people with commercial authority: intake, accept a quote, decide duplicates, accept a delivery, request a correction. */
const OWNER = [...READ, ...ASK, "intake.write", "quotes.accept", "decisions.record", "delivery.accept", "delivery.correct"];

/** Customer people without commercial authority: intake, read, and decide duplicates. */
const MEMBER = [...READ, ...ASK, "intake.write", "decisions.record"];

/** get-it staff working in a customer's organization. They never accept a quote or a delivery for the customer. */
const OPERATOR = [...READ, ...ASK, "intake.write", "quotes.write", "payments.record", "orders.accept", "orders.write", "imports.write", "runs.write", "review.request", "review.approve", "delivery.publish"];

export const ROLES = ["owner", "member", "operator"] as const;

export const app = feltkit({
  name: "get-it",
  description: "Outcome-driven service business. First outcome: bill review and payable preparation over Ledger-compatible bill sets.",
  roles: {
    person: [],
    owner: [...OWNER, "tenant.*"],
    member: MEMBER,
    operator: OPERATOR,
  },
  auth: {
    accounts: { roles: ["person"] },
    tenant: { name: "organization", roles: ROLES, create: "anyone" },
  },
});

const TENANT = { tenantId: s.string({ minLength: 1 }) };
const date = () => s.string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const sha = () => s.string({ pattern: "^sha256:[0-9a-f]{64}$" });

/** What the customer asked for, in their words. Recorded verbatim; it starts an intake. */
export const outcomeRequests = app.collection(
  "outcomeRequests",
  {
    ...TENANT,
    text: s.string({ minLength: 1, maxLength: 4000 }),
    contract: s.string(),
    requestedBy: s.string(),
    requestedAt: s.number(),
  },
  { tenant: true },
);

/** One intake, bound to the contract version it collects inputs for. Its completion is a separate fact. */
export const intakeSessions = app.collection(
  "intakeSessions",
  {
    ...TENANT,
    outcomeRequestId: s.string(),
    contract: s.string(),
    contractDigest: sha(),
    createdBy: s.string(),
    createdAt: s.number(),
  },
  { tenant: true },
);

/** An answer to (or a decline of) one contract input. Append-only; the latest per input wins until completion. */
export const intakeAnswers = app.collection(
  "intakeAnswers",
  {
    ...TENANT,
    sessionId: s.string(),
    field: s.string(),
    kind: s.enum(["answer", "decline"] as const),
    value: s.optional(s.unknown()),
    answeredBy: s.string(),
    answeredAt: s.number(),
  },
  { tenant: true, indexes: [{ fields: ["tenantId", "sessionId"] }] },
);

/** The bill set bound to an intake: its manifest of content-addressed records. Append-only; the latest binds. */
export const inputBindings = app.collection(
  "inputBindings",
  {
    ...TENANT,
    sessionId: s.string(),
    input: s.enum(["billSet"] as const),
    digest: sha(),
    manifest: s.array(s.object({ kind: s.enum(["account", "bill", "priorBill", "vendor"] as const), key: s.string(), digest: sha() })),
    counts: s.object({ bills: s.integer({ minimum: 0 }), vendors: s.integer({ minimum: 0 }), accounts: s.integer({ minimum: 0 }), priorBills: s.integer({ minimum: 0 }) }),
    boundBy: s.string(),
    boundAt: s.number(),
  },
  { tenant: true, indexes: [{ fields: ["tenantId", "sessionId"] }] },
);

/** A completed intake: the deterministic report, the bindings, the assumptions, the contract version. */
export const intakeCompleteness = app.collection(
  "intakeCompleteness",
  {
    ...TENANT,
    sessionId: s.string(),
    contract: s.string(),
    contractDigest: sha(),
    report: s.unknown(),
    reportDigest: sha(),
    bindings: s.unknown(),
    assumptions: s.array(s.object({ input: s.string(), how: s.enum(["declined", "not_answered", "not_supplied"] as const), statement: s.string() })),
    billSetBindingId: s.string(),
    billSetDigest: sha(),
    bills: s.integer({ minimum: 1 }),
    completedBy: s.string(),
    completedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "sessionId"]] },
);

/** A quote: the frozen price for the completed intake. Immutable; `digest` covers every commercial term. */
export const quotes = app.collection(
  "quotes",
  {
    ...TENANT,
    sessionId: s.string(),
    completenessId: s.string(),
    reportDigest: sha(),
    contract: s.string(),
    contractDigest: sha(),
    billCount: s.integer({ minimum: 1 }),
    priceMinor: s.integer({ minimum: 0 }),
    currency: s.string({ pattern: "^[A-Z]{3}$" }),
    pricing: s.object({ basePerRunMinor: s.integer(), includedBills: s.integer(), perAdditionalBillMinor: s.integer() }),
    assumptions: s.array(s.object({ input: s.string(), how: s.string(), statement: s.string() })),
    turnaroundBusinessDays: s.integer({ minimum: 1 }),
    validUntil: s.number(),
    digest: sha(),
    createdBy: s.string(),
    createdAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "completenessId"]] },
);

/** The customer's acceptance of one quote digest. One per quote; it creates the order. */
export const quoteAcceptances = app.collection(
  "quoteAcceptances",
  {
    ...TENANT,
    quoteId: s.string(),
    quoteDigest: sha(),
    orderId: s.string(),
    acceptedBy: s.string(),
    acceptedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "quoteId"]] },
);

/** A payment recorded by an operator (no payment provider). One per quote. */
export const payments = app.collection(
  "payments",
  {
    ...TENANT,
    quoteId: s.string(),
    quoteDigest: sha(),
    orderId: s.string(),
    amountMinor: s.integer({ minimum: 0 }),
    currency: s.string({ pattern: "^[A-Z]{3}$" }),
    method: s.enum(["bank_transfer", "check", "card_offline", "cash", "other"] as const),
    reference: s.string({ minLength: 1, maxLength: 200 }),
    idempotencyKey: s.string({ minLength: 1, maxLength: 200 }),
    recordedBy: s.string(),
    recordedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "quoteId"], ["tenantId", "idempotencyKey"]] },
);

/** The explicit acceptance of an order for fulfillment. It starts the turnaround clock. */
export const fulfillmentAcceptances = app.collection(
  "fulfillmentAcceptances",
  {
    ...TENANT,
    orderId: s.string(),
    paymentId: s.string(),
    completenessId: s.string(),
    contractDigest: sha(),
    /** Delegated grants the contract requires. This contract requires none: get-it reads no external system. */
    grants: s.array(s.string()),
    acceptedBy: s.string(),
    acceptedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "orderId"]] },
);

/** One review order, created by quote acceptance and bound to the frozen contract and the intake's bindings. */
export const orders = app.collection(
  "orders",
  {
    ...TENANT,
    quoteId: s.string(),
    sessionId: s.string(),
    completenessId: s.string(),
    contract: s.string(),
    contractDigest: sha(),
    homeCurrency: s.string({ pattern: "^[A-Z]{3}$" }),
    timeZone: s.string({ minLength: 1 }),
    asOfDate: date(),
    policy: s.object({ documentRequiredOverMinor: s.integer({ minimum: 0 }), dueSoonBusinessDays: s.integer({ minimum: 1 }) }),
    status: s.enum(["awaiting_payment", "paid", "accepted_for_fulfillment", "reviewing", "in_review", "delivered", "correcting", "delivery_accepted"] as const),
    clockStartedAt: s.optional(s.number()),
    createdBy: s.string(),
    createdAt: s.number(),
  },
  { tenant: true },
);

/** A customer-blocked interval starts or ends. Append-only; intervals are derived. */
export const blockEvents = app.collection(
  "blockEvents",
  {
    ...TENANT,
    orderId: s.string(),
    kind: s.enum(["start", "end"] as const),
    at: s.number(),
    reason: s.string({ minLength: 1, maxLength: 500 }),
    by: s.string(),
  },
  { tenant: true, indexes: [{ fields: ["tenantId", "orderId"] }] },
);

/**
 * A submitted input record (bill, vendor, account, prior bill), content-addressed within the
 * tenant: intake uploads and order imports share it, and identical content is stored once.
 */
export const sourceRecords = app.collection(
  "sourceRecords",
  {
    ...TENANT,
    kind: s.enum(["account", "bill", "priorBill", "vendor"] as const),
    key: s.string(),
    digest: sha(),
    record: s.unknown(),
    importedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "kind", "key", "digest"]], indexes: [{ fields: ["tenantId", "kind", "key"] }] },
);

/** A snapshot: the review scope plus the manifest of (kind, key, digest). Its digest ignores the import time. */
export const snapshots = app.collection(
  "snapshots",
  {
    ...TENANT,
    orderId: s.string(),
    digest: sha(),
    scope: s.unknown(),
    manifest: s.array(s.object({ kind: s.enum(["account", "bill", "priorBill", "vendor"] as const), key: s.string(), digest: sha() })),
    bills: s.integer({ minimum: 1 }),
    importedBy: s.string(),
    importedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "orderId", "digest"]] },
);

/** A review run: deterministic, so one per (snapshot, contract). */
export const runs = app.collection(
  "runs",
  {
    ...TENANT,
    orderId: s.string(),
    snapshotId: s.string(),
    snapshotDigest: sha(),
    contractDigest: sha(),
    outputDigest: sha(),
    packetDigest: sha(),
    output: s.unknown(),
    createdBy: s.string(),
    createdAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "snapshotId", "contractDigest"]] },
);

/** A review request: one approval packet, bound to its digest, awaiting a person's approval. */
export const packets = app.collection(
  "packets",
  {
    ...TENANT,
    orderId: s.string(),
    runId: s.string(),
    digest: sha(),
    requiringReview: s.integer({ minimum: 0 }),
    requestedBy: s.string(),
    requestedAt: s.number(),
    expiresAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "runId", "digest", "requestedAt"]] },
);

/** A person's approval of one packet digest. */
export const approvals = app.collection(
  "approvals",
  {
    ...TENANT,
    packetId: s.string(),
    digest: sha(),
    requestedBy: s.string(),
    approvedBy: s.string(),
    approverType: s.string(),
    approvedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "packetId"]] },
);

/** A customer's decision on a suspected duplicate. It never changes an accounting record. */
export const decisions = app.collection(
  "decisions",
  {
    ...TENANT,
    runId: s.string(),
    exceptionId: s.string(),
    decision: s.enum(["confirmed", "rejected", "acknowledged"] as const),
    note: s.optional(s.string({ maxLength: 2000 })),
    decidedBy: s.string(),
    decidedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "runId", "exceptionId"]] },
);

/** A published package: the approved packet, the acceptance report and the clock it was measured on. */
export const deliveries = app.collection(
  "deliveries",
  {
    ...TENANT,
    orderId: s.string(),
    runId: s.string(),
    packetId: s.string(),
    packetDigest: sha(),
    approvalId: s.string(),
    report: s.unknown(),
    publishedBy: s.string(),
    publishedAt: s.number(),
    deadline: s.number(),
    onTime: s.boolean(),
    correctionWindowEndsAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "packetId"]] },
);

/** The customer's acceptance of a delivery, in full or for named bills, with the charge it implies. */
export const acceptances = app.collection(
  "acceptances",
  {
    ...TENANT,
    deliveryId: s.string(),
    scope: s.enum(["full", "partial"] as const),
    acceptedBills: s.array(s.string()),
    billsCounted: s.integer({ minimum: 0 }),
    chargeMinor: s.integer({ minimum: 0 }),
    chargeBasis: s.string(),
    acceptedBy: s.string(),
    acceptedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "deliveryId"]] },
);

/** A customer's correction request on a delivery, within its window and before acceptance. */
export const corrections = app.collection(
  "corrections",
  {
    ...TENANT,
    deliveryId: s.string(),
    reason: s.string({ minLength: 1, maxLength: 2000 }),
    requestedBy: s.string(),
    requestedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "deliveryId"]] },
);

export const audit = app.auditTrail("audit", {
  subjects: ["intake", "quote", "payment", "order", "snapshot", "run", "packet", "decision", "delivery"] as const,
  tenant: true,
});
