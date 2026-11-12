# get-it: Outcome-Driven Service Business

## Implementation-Oriented Building Specification

**Status:** Revision 2, before contract freeze
**Date:** 2026-11-12
**Audience:** Product, platform, fulfillment, security and operations
**Supersedes:** Revision 1 (2026-11-12, "Proposed product and platform design")

### Changes from revision 1

| # | Change | Why |
|---|---|---|
| 1 | §3 rewritten from the verified stack inventory | Revision 1 mapped five of eight components to roles they do not perform. See [Evidence](#appendix-a-evidence). |
| 2 | Resolver, PAX, Intent, AppBoundry and FeltKit recast | Resolver is a `ref://` config resolver. PAX is a stateless evidence CLI. FeltDB's `Intent` is a developer planner. AppBoundry sits under products. FeltKit is the application platform. |
| 3 | Intake, commercial model, execution and acceptance records declared **new product code** | None of them exists anywhere in the stack. |
| 4 | Workflow runtime deferred (§11) | The first outcome runs on FeltKit's tested primitives. A runtime is chosen only against stated entry criteria. |
| 5 | Purpose-bound grants added (§7) | AuthBoundry delegations carry resource scope, expiry and revocation, but no purpose. The product enforces purpose until AuthBoundry can. |
| 6 | Tenant isolation is one FeltDB namespace per tenant (§15) | Owner decision. Consequence: one FeltKit deployment per tenant. |
| 7 | Approval limitations stated explicitly (§12) | AppPort only declares approvals. AuthBoundry approves only policy changes. FeltKit is the only enforcing mechanism. |
| 8 | Duplicate `OrderAccepted` event split (§10, §20) | It named both "accepted for fulfillment" and "customer accepted delivery". |
| 9 | First outcome and connector fixed (§5, §21) | Supplier invoice reconciliation. One read-only accounting/ERP connector, invoice and purchase-order reads only. |
| 10 | Spec acceptance tests revised (§25) | They now reference the mechanisms that actually exist. |

---

## 1. Executive summary

The business sells completed outcomes, not software configuration and not access to a provider marketplace. A
customer describes what they want done, supplies the required information and access, answers targeted questions,
reviews a scoped quote, purchases, and receives defined deliverables with evidence of completion.

get-it is a **FeltKit application**. It owns the commercial and fulfillment domain: service contracts, intake,
quotes, orders, grants, executions, deliverables, evidence and acceptance. It reuses the Boundry stack through its
existing contracts:
- FeltDB for durable state;
- AppPort for capability contracts;
- AuthBoundry for delegated authority;
- FeltKit for tenancy, idempotency, outbox, approvals and scheduling.

Customers never browse capabilities, hire providers, or see the internal fulfillment plan.

The durable commercial contract is:

> What we need from you → What we will do → What you will receive → How we prove it is done.

The service contract, order, evidence and acceptance records are product primitives owned by get-it. Workflow
engines, message buses, meters, payment processors and billing engines are replaceable adapters, and none is
introduced until a working outcome needs it.

## 2. Product thesis

### 2.1 Customer promise

Customers buy a result with explicit boundaries. The system must make clear:

- the intended outcome and success conditions;
- required and optional inputs, resources and access;
- actions the service may take and actions it may not take;
- deliverables, formats, timing and revision rules;
- price, usage assumptions and approval requirements; and
- evidence supporting completion.

### 2.2 Operating thesis

Fulfillment is a private construction problem. A service definition is a promise; a fulfillment plan is one way to
keep it. The plan may change without changing the customer-facing contract, provided the acceptance criteria remain
satisfied.

### 2.3 Durable representation

Every material state must be representable, inspectable, versioned and replayable: intake answers, grants, quote,
authorization, order, plan, execution, evidence, deliverables, invoices and acceptance. The system prefers
append-only facts plus derived views over opaque mutable state.

FeltDB has **no native append-only collection** (verified, `@feltdb/core` 0.21.0). Append-only is therefore a
product rule, enforced in code:
- fact collections are written only with `requireAbsent`;
- corrections are new facts, never updates; and
- a test asserts that no fact collection is ever updated or deleted.

### 2.4 Where intelligence is used

The first outcome is deterministic end to end. Matching, tolerance checks, exception classification, completeness and
export are rules over structured records. A model may later assist with ambiguity, such as extracting a PO reference
from free text. It may only propose: a deterministic rule or a human reviewer accepts or rejects the proposal, and
both the proposal and the decision are recorded as evidence. Removing the model must not remove the product.

## 3. Boundary map (verified)

Facts come from a read-only inventory of the repositories at the commits listed in Appendix A. "Use" says how get-it
consumes each component through its existing contract. Nothing here requires changing another product.

| Component | What it actually is | How get-it uses it |
|---|---|---|
| **FeltDB** (`@feltdb/core` 0.21.0) | Application database. Atomic multi-collection transactions with `requireAbsent`, `expectedVersion`, preconditions and idempotent `transactionId`. Enforced `unique` and `reference` fields. Content-addressed `storeContent` / `acquireContent` (sha256). `snapshot()` read models. One state contract per store name. | The single authority for all get-it state, through FeltKit. Source documents and deliverables are stored as content-addressed blobs. Append-only is enforced by get-it (§2.3). |
| **FeltKit** (`@feltdb/feltkit` 0.3.x) | Application platform on FeltDB. Server, client and React. Sessions and tenants. `FeltDbIdempotencyStore`. Transactional outbox (`ctx.afterCommit`). Person-only approvals bound to the sha256 digest of the exact operation and input, with expiry and authority re-checked at execution. Agent action lifecycle with compare-and-swap transitions and reconcile on restart. Recurring schedules. | **The application platform get-it is built on.** It supplies idempotent commands, human checkpoints, step durability (§11), outbox delivery of notifications, and schedules for recurring orders (Phase 3). |
| **AppPort** (core 1.7.x) | Capability contract protocol. Manifests with input/output schemas, scopes, `effect: observation \| consequential`, and idempotency keys bound to a request digest. Consequential capabilities are refused without a real authorizer. Transports: HTTP, MCP and others. | Every fulfillment unit (connector reads, matching, export) is an AppPort capability, so implementations are replaceable at the contract boundary. The connector's capabilities must all be `observation`. |
| **AuthBoundry** | Policy and authority service. Tenants. `Delegation{capabilities, resource_scope, expires_at, revoked_at, chain}`. Separate human, agent and service principals. Explainable decisions. Append-only audit that fails closed. AppPort adapter `createAuthBoundryAuthorizer`. | Backs every customer grant (§7) and every capability authorization decision. Its decision id is recorded in evidence. |
| **AppBoundry** | Artifact host and runtime, with a capability catalog, resolution, entitlements, composition, materialization, an execution ledger and provider lifecycle. It is a layer **under** products, not a product lifecycle. | Not used in Phase 1. It is the candidate capability catalog and plan resolver for Phase 2 composition (§16), subject to verification. Most runtime packages are private 0.1.0. |
| **Resolver** (`@appport/resolver`) | `ref://` reference resolver for values, secrets, models, endpoints and agents, with revisions, bindings and failover. It does **not** plan, ask questions or derive requirements. | Optional: resolves which connector endpoint or credential reference a capability uses at run time. The spec's former "Resolver" role is now **Intake** (§6), which is new get-it code. |
| **Intent** (FeltDB `IntentService`) | FeltDB's application-development planner: `raw_request → module plan → proposal`. Not a customer request model. | **Not used.** The customer's request is an `OutcomeRequest` (§19), so "intent" keeps one meaning in the ecosystem. |
| **PAX** | Stateless Rust CLI that observes software projects and delegates build/test to native tools. It holds no state and deliberately excludes retries and recovery. | **Not used.** It is not an execution runtime. It could supply evidence for a future software-delivery outcome. |
| **Boundry Intel** | Ecosystem registry and `boundry.event/1` acceptance: cross-product evidence that something happened, stored verbatim. | Optional. get-it may publish lifecycle telemetry as `boundry.event/1`. Boundry Intel is **never** get-it's order store or event log. |

**New product code in get-it.** Nothing in the stack provides these:
1. the commercial model: service contracts, quotes, orders, change requests, disputes, invoices;
2. intake: deriving questions and requirements from a contract, and checking completeness;
3. the fulfillment execution layer: step records, retry and resume, the evidence obligations of a plan;
4. acceptance records: executable acceptance criteria, decisions, corrections; and
5. the reconciliation domain for the first outcome.

## 4. Customer journeys

### 4.1 First-time purchase

1. Customer states an outcome in natural language or a short form. It is recorded verbatim as an `OutcomeRequest`.
2. Intake matches the request to a published service contract. In v1 there is one contract, and an unmatched request
   goes to an operator, not to a model.
3. Intake asks the minimum questions needed to bind the contract's open parameters.
4. Customer connects the accounting/ERP system and issues a read-only, purpose-bound grant (§7).
5. The system reports a completeness check of required, optional and blocked requirements, saying why each matters.
6. The system shows a contract preview: scope, exclusions, deliverables, acceptance criteria, timing and assumptions.
7. Pricing produces a quote.
8. Customer accepts the quote. Payment is recorded (§14). An order is created exactly once per idempotency key.
9. Order enters fulfillment. The customer sees status, requests for input, exceptions and projected completion.
10. A human reviewer approves the delivery packet (§12). Deliverables are published with evidence.
11. Customer accepts, requests a bounded correction, or disputes against the acceptance criteria.

### 4.2 Recurring service (Phase 3)

The contract defines cadence, service window, included volume, overage, renewal, cancellation and change control.
Each run is a child execution with its own evidence package. The parent order remains the commercial contract.
Scheduling uses FeltKit recurring schedules.

### 4.3 Missing access or blocked work

When a step needs something it does not have, the execution pauses at a **named prerequisite**:
- an expired grant;
- a connector error;
- a missing record; or
- a reviewer who has not yet decided.

It records the reason and requests the minimum new input or grant. It resumes from the last committed step. It
never broadens authority and never substitutes an unapproved resource.

## 5. Service contract

A versioned `ServiceContract` is the customer-facing definition of an outcome. Contracts are immutable once bound to a
paid order. Amendments create a new version and a `ChangeRequested` fact.

Required sections, unchanged from revision 1:
- outcome;
- inputs;
- requirements;
- deliverables;
- acceptance criteria;
- boundaries; and
- commercial terms.

### 5.1 First contract: supplier invoice reconciliation (draft for freeze)

**Outcome.** For a stated period and scope, reconcile every supplier invoice in the customer's accounting/ERP system
against its purchase order. Produce:
- reconciled records;
- discrepancy exceptions;
- an evidence package; and
- an export.

**Match type: two-way (invoice ↔ purchase order).** The connector reads invoices and purchase orders only, so goods
receipts are not available. **Three-way matching (receipt of goods) is explicitly excluded** and stated in the
contract preview.

**Inputs**

| Id | Kind | Required | Source |
|---|---|---|---|
| `scope.period` | date range (invoice date) | yes | intake |
| `scope.entities` | legal entities or companies in the ERP | yes (default: all the grant covers) | intake |
| `scope.suppliers` | supplier filter | no (default: all) | intake |
| `tolerance` | price, quantity and total tolerances (absolute and/or %) | yes (default proposed, customer confirms) | intake |
| `invoices` | canonical `Invoice` records | yes | connector, read |
| `purchase_orders` | canonical `PurchaseOrder` records | yes | connector, read |

**Requirements**

| Id | Kind |
|---|---|
| `erp_read_grant` | grant: read `invoice` and `purchase_order` for the scoped entities, purpose = this order, expiring no later than the order's service window |
| `reviewer` | a named customer-side or operator reviewer for exceptions above threshold |

**Deliverables**

| Id | Content | Format |
|---|---|---|
| `reconciled_records` | one record per in-scope invoice: `status ∈ {matched, matched_within_tolerance, discrepancy, unmatched}`, the matched PO and lines, the computed variances, and source references | JSON and CSV |
| `exceptions` | one exception per discrepancy or unmatched invoice, typed (below), with amount at stake and the evidence for it | JSON and CSV |
| `evidence_package` | the source snapshot manifest (record ids plus content hashes), rule and contract versions, every capability call summary, authority decision ids, the reviewer's approval, and acceptance-test results | JSON |
| `export` | `reconciled_records` and `exceptions` as one downloadable bundle | CSV + JSON, zipped |

Exception types (closed set in v1): `no_po_reference`, `po_not_found`, `supplier_mismatch`, `currency_mismatch`,
`price_variance`, `quantity_variance`, `total_variance`, `po_overbilled` (cumulative invoices exceed the PO),
`duplicate_invoice`.

**Acceptance criteria** (each executable)

| Id | Test |
|---|---|
| `completeness` | The set of reconciled records equals the set of in-scope invoices in the source snapshot: each appears exactly once. |
| `traceability` | Every reconciled record and exception cites source record ids whose content hashes are in the snapshot manifest. |
| `arithmetic` | Every variance recomputes from the cited sources to the stated value. |
| `tolerance` | A record is `matched_within_tolerance` iff every variance is within the bound tolerance; `discrepancy` otherwise. |
| `read_only` | Every capability invocation for the order has `effect: observation`. No grant held for the order includes a write, send, delete or payment scope. |
| `reviewed` | Every exception above the review threshold is covered by a recorded person approval of the delivery packet. |
| `on_time` | Deliverables were published before the committed completion time. |

**Boundaries** (excluded actions): writing to the ERP; approving, holding or paying invoices; sending email or any
message to suppliers; contacting suppliers; three-way matching; currency conversion. Mixed currencies are reported as
`currency_mismatch`, never converted.

**Parameters that must be fixed to freeze the contract** (owner decisions, §26):
- default tolerances;
- review threshold;
- price model and unit (per invoice, per period, or fixed + per invoice);
- included volume;
- committed turnaround;
- correction window; and
- which ERP the first connector targets.

## 6. Intake (new product code)

Intake is deterministic in v1. A contract declares its open parameters and requirements. Intake derives one question
per unbound parameter. Each question declares:
- purpose;
- answer type;
- sensitivity;
- requiredness rule;
- dependency; and
- the default proposed to the customer.

Intake stops when every required parameter is bound or explicitly defaulted with a recorded assumption.

The ambiguity pattern from FeltDB's Intent model is reused, not the model itself. An unresolvable answer becomes an
`ambiguity{code, message, candidates}` that the customer or an operator must settle.

Intake must support:
- conditional questions;
- explicit assumptions for declined optional inputs;
- validation and provenance per answer;
- re-opening when a quote changes materially; and
- a completeness report.

Secrets and credentials are never intake answers. A connection is a grant (§7). Intake stores only the grant's id.

## 7. Inputs, resources and access: purpose-bound grants

An input is data the service consumes. A resource is a capability or authority used to obtain it.

A **`ResourceGrant`** is get-it's durable record of authority granted for one purpose. It is backed by an
AuthBoundry delegation.

| Field | Meaning |
|---|---|
| `purpose` | `{ orderId, contractId, contractVersion }`. A grant is usable only by executions of that order. |
| `operations` | the exact capabilities allowed (v1: the connector's `invoice.list`, `invoice.get`, `purchase_order.list`, `purchase_order.get`, all `observation`) |
| `resourceScope` | ERP entities (and suppliers if narrowed). Maps to AuthBoundry `resource_scope`. |
| `expiresAt` | no later than the order's service window end. Maps to AuthBoundry `expires_at`. |
| `delegationId` | the AuthBoundry delegation backing it |
| `status` | `active → revoked \| expired`, recorded as facts |

**Enforcement.** Every capability invocation passes two checks:
1. AuthBoundry `authorize/check` for the delegation (capability, resource and expiry); and
2. a **purpose check in get-it**: the invoking execution belongs to `purpose.orderId`, and the capability is in
   `operations`.

AuthBoundry has no purpose field today. Until it does, check 2 is get-it's responsibility and is tested. The
missing purpose field is recorded as an AuthBoundry gap, not worked around inside AuthBoundry.

A revoked or expired grant makes the next invocation fail closed, and the execution pauses at a named prerequisite
(§4.3). Credentials stay with the connector's credential store or a Resolver secret reference. They are never in
get-it records, prompts or logs.

## 8. Deliverables and acceptance (new product code)

Every deliverable has:
- an immutable identity and a content hash (FeltDB `storeContent`);
- a format and a producer;
- source references;
- a created time;
- a retention policy; and
- an acceptance status.

Acceptance criteria are executed by code at delivery. Their results are part of the evidence package. A failing
criterion blocks publication and opens an operator exception. It is never delivered with a footnote.

Customer responses are recorded facts:
- `DeliveryAccepted`;
- `CorrectionRequested` (bounded: a re-run or fix against the same contract version); and
- `DeliveryDisputed` (with the criterion disputed).

New requirements are a `ChangeRequest`, which re-quotes.

## 9. Quoting and pricing (new product code)

A quote is a snapshot of a resolved plan. It includes:
- contract version and bound parameters;
- assumptions;
- expected volume (from a read-only count through the grant, where the customer has granted access before
  quoting; otherwise the customer's estimate, marked as such);
- fixed, usage and pass-through fees, and the total;
- validity window;
- committed completion window;
- customer obligations;
- cancellation, refund, overage and change rules; and
- provenance (pricing rules version and plan hash).

Pricing is a deterministic rule set behind a `QuotePricing` function. No metering product is introduced. AppPort
capabilities carry no cost metadata, so internal cost per capability is held by get-it.

## 10. Order lifecycle

```text
draft → intake → quotable → quoted → authorized → paid → accepted_for_fulfillment
      → planned → running ⇄ waiting_for_customer
      → in_review → delivered → delivery_accepted
      → correcting | disputed | cancelled | failed
```

Each transition is a command with a FeltKit idempotency key. It is guarded by policy and recorded as a fact carrying:
- actor and authority decision id;
- reason;
- contract version; and
- correlation and causation ids.

The order's current state is a projection of its facts. Payment never authorizes an action outside the accepted
contract.

## 11. Fulfillment execution (new product code; no workflow runtime yet)

For the first outcome, the plan is a fixed, versioned sequence:

```text
snapshot sources → normalize → match → classify exceptions → run acceptance criteria
                 → request review → publish deliverables
```

Each step is an `ExecutionStep` record. Its transitions are FeltDB conditional writes (`expectedVersion`), following
FeltKit's agent action lifecycle pattern (compare-and-swap transitions, reconcile on restart). A step is idempotent:
- the source snapshot is content-addressed; and
- every later step is a pure function of the snapshot, the bound parameters and the rules version.

So a retry recomputes the same output.

Retries are bounded per step and recorded. A failed step pauses the execution with a named reason and surfaces it to
operators. Pause and resume continue from the last committed step. Notifications leave through the FeltKit outbox,
after commit.

**Workflow runtime: deferred.** A runtime (Temporal or another) is introduced only when **all** of these hold:
- the first outcome passes §25 end to end in production;
- a concrete need is not met by step records plus schedules: durable timers beyond FeltKit schedules, compensation
  across external writes, or fan-out of more than one execution per order; and
- the runtime sits behind an `ExecutionRuntime` port, with the step records remaining the source of truth.

## 12. Human and agent authority: approval limitations

| Mechanism | What it does | Limitation |
|---|---|---|
| AppPort `approval` declaration | A capability contract may state that an approval is required | **Declaration only.** "AppPort does not collect, check or record approvals." |
| AuthBoundry proposals | `pending → approved → applied` with `approved_by` | **Only for changes to policy or authority.** It does not gate an individual action. |
| FeltKit approvals | Person-only; the proposer cannot approve; bound to the sha256 digest of the exact operation and input; expire; authority re-checked at execution | **The only enforcing mechanism.** Used for every human checkpoint in get-it. |

Consequences:
- Every human checkpoint in get-it is a FeltKit approval over the exact artifact digest being approved. For v1 that
  is the delivery packet (records, exceptions and evidence manifest).
- An agent cannot approve.
- Approving a packet does not approve a different packet. A re-run invalidates the approval and needs a new one.
- There is **no** cross-product per-action approval enforcement. A capability that needs approval can only be
  invoked by get-it after get-it has checked an approval. This holds only while get-it is the sole invoker.
- In v1 no action is high-impact by construction: every capability is `observation`.

Each action records:
- actor type and identity;
- authority decision id;
- input and output references;
- capability invocations; and
- the result.

"Agent completed" is never evidence of acceptance.

## 13. Evidence and audit

The evidence graph links contract requirements to inputs, actions, decisions, outputs and acceptance results.
Minimum evidence types:
- source reference (record id and content hash);
- transformation record (step, rules version, input and output hashes);
- authority decision (AuthBoundry decision id);
- human approval (FeltKit approval id and digest);
- capability invocation summary;
- validation result;
- exception; and
- delivery receipt.

**Limitation:** evidence is append-only by get-it's convention and content-addressed. It is **not tamper-evident**:
nothing in the stack hash-chains or signs records. Hash-chaining the evidence log is a Phase 4 item, not a v1 claim.

## 14. Billing and payment (new product code)

Billing consumes commercial facts:
- `QuoteAccepted`;
- `PaymentRecorded`;
- `UsageRecorded` (derived from execution facts: invoices processed);
- `CreditIssued`;
- `RefundApproved`; and
- `InvoiceIssued`.

The order and quote remain authoritative for scope.

**No payment integration exists in the stack** (AppBoundry has payment contract schemas only). v1 uses a
`PaymentProvider` port with one adapter. The default proposal is an operator-recorded payment against an issued
invoice, which satisfies idempotent order authorization without a processor. A card processor adapter is an owner
decision (§26).

## 15. Tenancy and security

**Isolation (owner decision): one FeltDB namespace per tenant.**

Consequence, verified: FeltKit opens one FeltDB instance per environment. So a namespace per tenant means **one get-it
deployment (FeltKit environment and state directory) per tenant**. Cross-tenant reads are then impossible by
construction, not by query filtering.

This has costs:
- per-tenant provisioning;
- per-tenant upgrades and contract evolution; and
- operator views that span tenants.

Operator views are a separate read-only tool that reads each tenant's deployment with operator credentials. It is
never a shared database.

FeltKit's in-store tenant isolation (`{ tenant: true }` collections, enforced on every read and write and covered by
its test suite) is the alternative if per-tenant deployment becomes the bottleneck. Switching is a recorded decision,
not a drift.

Also required:
- AuthBoundry tenant on every grant (`TenantCurrent`);
- encryption in transit and at rest (deployment);
- credentials outside get-it records and logs;
- append-only facts;
- retention and deletion policies; and
- an export workflow.

Security review gates any connector that can write, send, delete or move money. None exists in v1.

## 16. Capabilities and providers

A provider is an internal fulfillment role. A capability is an AppPort capability with a declared contract.
Requirements beyond AppPort (cost, capacity, data residency) are held by get-it in a capability profile until a
shared home is justified.

Phase 1 has exactly two kinds of capability:
1. the connector's read capabilities; and
2. get-it's own deterministic steps.

Phase 2 evaluates the AppBoundry runtime's catalog, resolution and composition as the plan compiler, instead of
building one.

## 17. Admin and operations

Operators need queues for:
- blocked executions;
- expiring grants;
- failed steps;
- evidence gaps;
- failed acceptance criteria;
- disputes; and
- SLA risk.

Admin actions are scoped, reasoned and audited. They are recorded as facts with the operator's identity.

## 18. Architecture

```text
Customer UI / API (FeltKit client)
        ↓
get-it (FeltKit application): intake → quote → order → execution → delivery → acceptance
        ├─ AuthBoundry: tenant, delegation and decision for every capability invocation
        ├─ AppPort capabilities: connector reads (observation) and get-it steps
        ├─ FeltKit: idempotency, approvals, outbox, schedules
        └─ FeltDB (namespace per tenant): facts, step records, content-addressed artifacts, projections
                                          ↘ optional: boundry.event/1 telemetry to Boundry Intel
```

Ports, each with an in-memory adapter for tests:
- `ContractCatalog`
- `ErpConnector` (read-only)
- `GrantProvider` (AuthBoundry)
- `PaymentProvider`
- `ArtifactStore` (FeltDB content)
- `NotificationProvider` (FeltKit outbox)

`ExecutionRuntime` exists only as the boundary that §11 defers.

## 19. Core data model

Entities:
- `Tenant` (one per deployment)
- `Principal`
- `OutcomeRequest` (replaces revision 1's `Intent`)
- `ServiceContract`
- `IntakeSession`
- `InputBinding`
- `ResourceGrant`
- `Quote`
- `Order`
- `FulfillmentPlan`
- `Execution`
- `ExecutionStep`
- `SourceSnapshot`
- `Invoice` and `PurchaseOrder` (canonical, connector-neutral)
- `ReconciledRecord`
- `Exception`
- `Deliverable`
- `EvidenceRecord`
- `AcceptanceResult`
- `AcceptanceDecision`
- `UsageRecord`
- `Invoice (billing)` (named `BillingInvoice` in code to avoid the collision)
- `ChangeRequest`
- `Dispute`

Common fields: `id`, `version`, `status`, `createdAt`, `createdBy`, `correlationId`, `causationId`, `schemaVersion`,
`provenance`. Facts are append-only. Projections are disposable and rebuildable.

## 20. APIs and events

Commands, exposed as FeltKit mutations / AppPort capabilities, each idempotent:
- `outcomeRequests.create`
- `intake.answer`
- `intake.resolve`
- `grants.issue`
- `grants.revoke`
- `quotes.create`
- `quotes.accept`
- `payments.record`
- `orders.cancel`
- `orders.requestChange`
- `deliverables.approvePacket`
- `deliverables.accept`
- `deliverables.requestCorrection`
- `deliverables.dispute`

Events (facts):
- `OutcomeRequested`
- `RequirementDiscovered`
- `InputBound`
- `GrantIssued`
- `GrantRevoked`
- `GrantExpired`
- `QuoteCreated`
- `QuoteAccepted`
- `PaymentRecorded`
- **`OrderAcceptedForFulfillment`**
- `PlanCompiled`
- `ExecutionStarted`
- `StepCompleted`
- `ExecutionPaused`
- `ExecutionResumed`
- `ApprovalRequested`
- `PacketApproved`
- `UsageRecorded`
- `DeliverablePublished`
- **`DeliveryAccepted`**
- `CorrectionRequested`
- `DeliveryDisputed`
- `ChangeRequested`
- `InvoiceIssued`

Revision 1's duplicate `OrderAccepted` is split:
- `OrderAcceptedForFulfillment` means the business committed to fulfill.
- `DeliveryAccepted` means the customer accepted the result.

Every fact has:
- event id;
- aggregate id and version;
- timestamp;
- actor;
- authority decision id;
- correlation and causation ids; and
- payload schema version.

The tenant is implicit in the deployment, and recorded in the envelope for export. Consumers are idempotent.

## 21. MVP scope

In:
- one service contract (supplier invoice reconciliation, two-way match);
- one ERP connector with read-only invoice and PO capabilities;
- tenancy as namespace per tenant;
- deterministic intake and pricing;
- operator-recorded payment;
- step-record execution;
- one human checkpoint (delivery packet approval);
- content-addressed evidence;
- the export; and
- a customer delivery view.

Out:
- ERP writes;
- payment execution;
- email or supplier messaging;
- three-way match;
- currency conversion;
- a public capability marketplace;
- provider bidding;
- arbitrary workflow authoring;
- a workflow runtime;
- metering products;
- multi-currency tax;
- more than one connector; and
- model-driven matching.

## 22. Phased roadmap

**Phase 0: Contract kernel.**
- Freeze the §5.1 contract and the acceptance criteria.
- Build the FeltKit app skeleton, canonical `Invoice` / `PurchaseOrder`, the fact envelope and the append-only
  rule.
- Use in-memory connector, grant and payment adapters.

**Phase 1: One outcome end to end.** The real connector (read-only), AuthBoundry-backed grants with the purpose
check, quote, payment record, order, execution, review approval, delivery, acceptance, correction and dispute.

**Phase 2: Composition.**
- Evaluate the AppBoundry runtime as the plan compiler.
- Add usage accounting, operator queues and a second contract.
- Make the workflow runtime decision against the §11 criteria.

**Phase 3: Recurrence and connectors.** Recurring orders (FeltKit schedules), grant renewal, a second connector,
change requests and billing reconciliation.

**Phase 4: Scale and governance.**
- Tamper-evident evidence.
- Purpose binding inside AuthBoundry, if it adopts it.
- Per-action approval enforcement across products.
- Data residency.
- Revisit tenancy (§15).

## 23. Non-goals

Unchanged from revision 1. Also: get-it does not extend or fork Resolver, PAX, FeltDB Intent or AppBoundry to fit
this product. It consumes their contracts, or it builds what it needs itself.

## 24. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Outcome underspecified | Deterministic intake with recorded assumptions. Every acceptance criterion executable. |
| Scope expands during fulfillment | Immutable contract version per order. Change requests re-quote. |
| Grant used outside its purpose | AuthBoundry delegation plus get-it purpose check on every invocation, both tested. |
| Approval bypassed | Only FeltKit approvals count. They are digest-bound, so a re-run invalidates them. |
| Evidence incomplete | Acceptance criteria run before publication. A failure blocks delivery. |
| Evidence tampering | Not mitigated in v1 (no tamper evidence in the stack). Disclosed. Phase 4. |
| Per-tenant deployment overhead | Scripted provisioning. Tenancy model revisited with evidence (§15). |
| FeltDB managed/remote mode unverified | v1 runs embedded local per tenant deployment, as Boundry Intel does. Remote is a separate verification. |
| AuthBoundry ↔ AppPort version drift (1.0.2 vs 1.7.x) | Verify the `createAuthBoundryAuthorizer` adapter against get-it's AppPort version in Phase 1 before relying on it. |
| Connector rate limits or partial reads | The snapshot records the source counts. `completeness` fails if the snapshot is partial. |

## 25. Acceptance tests (first release)

1. A customer goes from a stated outcome to a quote without seeing internal capabilities.
2. Required, optional and defaulted inputs are distinguished, and every default is a recorded assumption.
3. A quote names its contract version, parameters, assumptions, price, timing, deliverables and exclusions
   (including "no three-way match").
4. Recording payment twice under one idempotency key creates exactly one `OrderAcceptedForFulfillment`.
5. A capability invocation without a matching active grant, or with a grant of another order's purpose, is refused,
   and the refusal is recorded.
6. A failed step retries or pauses, and resuming from the last committed step yields byte-identical deliverables.
7. Every published record and exception links to snapshot hashes, and all seven §5.1 acceptance criteria pass.
8. A customer can accept, request a bounded correction, or dispute naming a criterion.
9. A changed requirement produces a `ChangeRequest` and a new quote, never a silent change.
10. A revoked or expired grant prevents the next invocation and pauses the execution with a named prerequisite.
11. Usage and billing facts reconcile to execution facts (invoices processed).
12. Rebuilding projections from facts reproduces the customer-visible order state.
13. Tenant isolation: two tenant deployments share no FeltDB namespace, and no credential issued for one is accepted
    by the other.
14. Replacing the connector, grant or payment adapter with its in-memory adapter does not change the command API.
15. No fact collection is ever updated or deleted (§2.3). No capability with a non-`observation` effect is
    registered in v1.
16. A packet approval does not cover a re-run's different packet.

## 26. Open decisions

**Resolved in this revision:**
- authoritative repositories (Appendix A);
- PAX (not used);
- Intent/Resolver (not reused; renamed roles);
- the first outcome and connector scope;
- the repository (get-it); and
- the tenancy model (namespace per tenant).

**Needed to freeze the §5.1 contract:**
1. The target ERP for the first connector.
2. Default tolerances (price, quantity, total) and the review threshold.
3. Price model, unit, included volume and committed turnaround.
4. The correction window, and the commercial treatment of failed, partial and customer-blocked work.
5. Who reviews: a customer-side person, an operator, or either.

**Needed before Phase 1 ships:**
6. Payment adapter (default proposal: operator-recorded payment).
7. Retention, deletion and export obligations for customer financial data.
8. Which FeltDB authority hosts tenant deployments in production (embedded local is the verified path).

## 27. Implementation sequence

1. ~~Inventory the Boundry stack~~ (done: Appendix A).
2. Settle §26 items 1–5 and freeze `ServiceContract` `svc_invoice_reconciliation@1.0.0` with its acceptance criteria
   as executable tests over fixtures.
3. Build the FeltKit app skeleton: the fact envelope, the append-only rule, idempotent commands, and in-memory
   adapters.
4. Build intake → quote with the in-memory connector.
5. Build the reconciliation steps and acceptance criteria over recorded fixtures.
6. Add AuthBoundry grants with the purpose check, then the real read-only connector.
7. Add payment record, review approval, delivery, acceptance, correction and dispute.
8. Add operator queues and failure recovery before adding any capability or runtime.

The product is ready to scale when the customer promise stays stable while connectors, providers and infrastructure
evolve behind it.

---

## Appendix A: Evidence

The full inventory, with file and line citations, is in
[`rkendel1/boundry-intel` `docs/service-business/stack-inventory.md`](https://github.com/rkendel1/boundry-intel/blob/claude/friendly-cori-9xsudl/docs/service-business/stack-inventory.md).
Repositories were read at these commits:

| Repo | Commit |
|---|---|
| feltkit | f7febca |
| appboundry | d791879 |
| authboundry | da46b26 |
| appport | e91fd39 |
| resolver | 5c827aa |
| resolver-control | d41ef9e |
| pax | aab5039 |
| boundry | 3a5400d |

FeltDB facts come from the published `@feltdb/core` 0.21.0. Its source repository was not read. FeltKit's tenancy and
instance model, added in this revision, were read in `packages/sdk/src/runtime/instance.ts`, `tenant-scope.ts` and
`test/tenancy.test.ts`. Other repositories' test suites were read, **not run**.
