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
 * projection of its facts) is written with `insert` only. The integrity check recomputes digests to
 * detect drift; FeltDB has no write-once collections.
 *
 * Execution is stored steps, with no workflow runtime: import → review → request → approve →
 * publish → accept or correct. Each step is a mutation that commits one fact.
 */
import { feltkit, s } from "@feltdb/feltkit";

const READ = ["orders.read", "imports.read", "runs.read", "review.read", "decisions.read", "delivery.read", "integrity.read"];

/** Anyone in an organization may ask for an accounting action. It is always refused (accounting.ts). */
const ASK = ["accounting.request"];

/** Customer people with authority: decide duplicates, accept a delivery, request a correction. */
const OWNER = [...READ, ...ASK, "decisions.record", "delivery.accept", "delivery.correct"];

/** Customer people without commercial authority: read, and decide duplicates. */
const MEMBER = [...READ, ...ASK, "decisions.record"];

/** get-it staff working in a customer's organization. */
const OPERATOR = [...READ, ...ASK, "orders.write", "imports.write", "runs.write", "review.request", "review.approve", "delivery.publish"];

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

/** One review order, bound to the frozen contract version and its review scope. */
export const orders = app.collection(
  "orders",
  {
    ...TENANT,
    contract: s.string(),
    contractDigest: sha(),
    homeCurrency: s.string({ pattern: "^[A-Z]{3}$" }),
    timeZone: s.string({ minLength: 1 }),
    asOfDate: date(),
    policy: s.object({ documentRequiredOverMinor: s.integer({ minimum: 0 }), dueSoonBusinessDays: s.integer({ minimum: 1 }) }),
    status: s.enum(["intake", "reviewing", "in_review", "delivered", "correcting", "accepted"] as const),
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

/** A submitted input record (bill, vendor, account, prior bill), content-addressed. Re-importing identical content adds nothing. */
export const sourceRecords = app.collection(
  "sourceRecords",
  {
    ...TENANT,
    orderId: s.string(),
    kind: s.enum(["account", "bill", "priorBill", "vendor"] as const),
    key: s.string(),
    digest: sha(),
    record: s.unknown(),
    importedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "orderId", "kind", "key", "digest"]], indexes: [{ fields: ["tenantId", "orderId"] }] },
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
  subjects: ["order", "snapshot", "run", "packet", "decision", "delivery"] as const,
  tenant: true,
});
