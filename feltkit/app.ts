/**
 * get-it on FeltKit.
 *
 * Tenancy: FeltKit's in-store tenant model. Each customer organization is a FeltKit tenant
 * (`auth.tenant`), and get-it's staff work in it as members with the `operator` role.
 *
 * - Every collection is `{ tenant: true }`: FeltKit limits every read and write to the caller's live
 *   tenant, and refuses a write naming another one.
 * - Every collection also **declares `tenantId` as a required field**. get-it sets it explicitly
 *   from the session's tenant (`requireTenant`) on every insert. Every unique constraint therefore
 *   includes it, and a record without its tenant cannot be stored.
 * - The integrity check (integrity.ts) verifies the invariant on every record.
 *
 * Facts are append-only by rule: every collection except `orders` (whose `status` is a projection
 * of its facts) is written with `insert` only. The integrity check recomputes digests to detect
 * drift. FeltDB has no write-once collections, so this is a convention plus detection, not storage
 * enforcement.
 */
import { feltkit, s } from "@feltdb/feltkit";

const READ = ["orders.read", "imports.read", "runs.read", "review.read", "decisions.read", "integrity.read"];

/** Customer people: read their organization's work and decide its ambiguous business questions. */
const CUSTOMER = [...READ, "decisions.record"];

/** get-it staff working in a customer's organization: everything operational, including review. */
const OPERATOR = [...READ, "orders.write", "imports.write", "runs.write", "review.request", "review.approve"];

export const ROLES = ["owner", "member", "operator"] as const;

export const app = feltkit({
  name: "get-it",
  description: "Outcome-driven service business. First outcome: supplier invoice reconciliation against QuickBooks Online, read-only.",
  roles: {
    person: [],
    owner: [...CUSTOMER, "tenant.*"],
    member: CUSTOMER,
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

/** One reconciliation order: the frozen contract version it is bound to and its bound inputs. */
export const orders = app.collection(
  "orders",
  {
    ...TENANT,
    contract: s.string(),
    contractDigest: sha(),
    realmId: s.string({ pattern: "^\\d+$" }),
    from: date(),
    to: date(),
    vendorIds: s.array(s.string()),
    homeCurrency: s.string({ pattern: "^[A-Z]{3}$" }),
    timeZone: s.string({ minLength: 1 }),
    status: s.enum(["intake", "running", "in_review", "delivered"] as const),
    createdBy: s.string(),
    createdAt: s.number(),
  },
  { tenant: true },
);

/** A canonical source record, content-addressed. Re-importing identical content adds nothing. */
export const sourceRecords = app.collection(
  "sourceRecords",
  {
    ...TENANT,
    orderId: s.string(),
    kind: s.enum(["bill", "purchaseOrder"] as const),
    sourceId: s.string(),
    digest: sha(),
    record: s.unknown(),
    importedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "orderId", "kind", "sourceId", "digest"]], indexes: [{ fields: ["tenantId", "orderId"] }] },
);

/** A snapshot: the scope plus the manifest of (kind, id, digest). Its digest ignores the fetch time. */
export const snapshots = app.collection(
  "snapshots",
  {
    ...TENANT,
    orderId: s.string(),
    digest: sha(),
    scope: s.unknown(),
    manifest: s.array(s.object({ kind: s.enum(["bill", "purchaseOrder"] as const), id: s.string(), digest: sha() })),
    bills: s.integer({ minimum: 0 }),
    purchaseOrders: s.integer({ minimum: 0 }),
    importedBy: s.string(),
    importedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "orderId", "digest"]] },
);

/** A reconciliation run: deterministic, so one per (snapshot, contract). */
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

/** A review request: one delivery packet (bound to its digest) awaiting a person's approval. */
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
  { tenant: true, unique: [["tenantId", "runId", "digest"]] },
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

/** A customer's decision on an ambiguous business question. It never changes the source system. */
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

export const audit = app.auditTrail("audit", {
  subjects: ["order", "snapshot", "run", "packet", "decision"] as const,
  tenant: true,
});
