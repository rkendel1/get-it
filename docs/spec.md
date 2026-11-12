# get-it: Outcome-Driven Service Business

## Implementation-Oriented Building Specification

**Status:** Revision 4. The first service is `svc_bill_review_payable_prep@1.0.0`, which is **frozen**.
**Date:** 2026-11-12
**Audience:** Product, platform, fulfillment, security and operations
**Supersedes:** Revisions 1–3

### Changes from revision 3

| # | Change | Where |
|---|---|---|
| 1 | The first service is now **bill review and payable preparation** over customer-supplied, **Ledger-compatible bill sets**. No external accounting system, ERP connector or credential is part of the MVP. | §5, §7 |
| 2 | New frozen contract `svc_bill_review_payable_prep@1.0.0`, pinned at `sha256:6097d09b5f39d202412bae4e69ad94e45768829c1f9149f12cc7648863f3c637`. | §5.1 |
| 3 | `svc_invoice_reconciliation@1.0.0` is **retired**. It was never bound to an order. Its pin is kept so its id and version are never reused. The connector, the purchase-order matching, its acceptance criteria and its tests are removed. | §5, `contracts/frozen.json` |
| 4 | No purchase orders, quantities, unit prices or three-way matching. Bills are reviewed on their own fields, the customer's reference data, and prior bills. | §5.1 |
| 5 | The accounting boundary is explicit: get-it never creates, approves, posts, pays, voids, sends or deletes an accounting record. Asking for one is refused. | §7 |
| 6 | Delivery, acceptance (full or partial), correction and customer-blocked time are implemented as stored steps. | §10, §11 |

Revisions 2 and 3 settled the platform. These decisions are unchanged:
- get-it is a FeltKit application;
- tenancy is FeltKit's in-store model with an explicit `tenantId`;
- approvals are person-only and digest-bound;
- facts are append-only with integrity checks;
- no workflow runtime yet; and
- Ledger is a reference only.

---

## 1. Executive summary

The business sells completed outcomes, not software configuration and not access to a provider marketplace. A
customer describes what they want done, supplies the required information, reviews a scoped quote, purchases, and
receives defined deliverables with evidence of completion.

get-it is a **FeltKit application**. It owns the commercial and fulfillment domain: service contracts, intake,
quotes, orders, executions, deliverables, evidence and acceptance. It reuses the Boundry stack through existing
contracts:
- FeltDB for durable state;
- FeltKit for tenancy, idempotency, approvals and scheduling;
- AppPort for capability contracts (later phases); and
- AuthBoundry for delegated authority (later phases).

The durable commercial contract is:

> What we need from you → What we will do → What you will receive → How we prove it is done.

**The first outcome.** The customer submits the supplier bills awaiting approval, with the vendor and account
records they name, as a Ledger-compatible bill set. get-it:
1. validates each bill's completeness and arithmetic;
2. classifies duplicates, currency and policy exceptions;
3. prepares advisory payable recommendations;
4. has a person approve the review package; and
5. delivers it with evidence linking every result to its input and its checks.

get-it changes nothing in the customer's books.

## 2. Product thesis

### 2.1 Customer promise

The contract makes explicit:
- the outcome and success conditions;
- the required and optional inputs;
- the actions the service takes and never takes;
- the deliverables and their formats;
- timing and correction rules;
- the price and the charging rules; and
- the evidence of completion.

### 2.2 Durable representation

Every material state is representable, inspectable and replayable:
- the inputs as submitted;
- snapshots, runs, packets, approvals and decisions;
- deliveries, acceptances and corrections.

FeltDB has **no native append-only collection**, so append-only is a product rule:
- facts are written with `insert` only;
- corrections are new facts; and
- the integrity check recomputes every digest to detect drift.

### 2.3 Where intelligence is used

The first outcome is deterministic end to end. No model is used. If one is added later (for example, to read a
receipt), it may only propose, a deterministic rule or a person accepts or rejects, and both are recorded. Removing
the model must not remove the product.

## 3. Boundary map (verified)

Facts come from a read-only inventory of the repositories listed in Appendix A.

| Component | What it actually is | How get-it uses it |
|---|---|---|
| **FeltDB** (`@feltdb/core` 0.21.0) | Application database: atomic multi-collection transactions, `requireAbsent`, `expectedVersion`, `unique` and `reference` fields, content-addressed content, one state contract per store. | The single authority for get-it state, through FeltKit. |
| **FeltKit** (`@feltdb/feltkit` 0.3.27) | Application platform on FeltDB: one instance per environment, in-store tenant isolation through `{ tenant: true }` collections, sessions, idempotency store, outbox, person-only digest-bound approvals, schedules. | **The platform get-it is built on.** |
| **AppPort** (core 1.7.x) | Capability contract protocol: manifests, schemas, `effect: observation \| consequential`, idempotency keys. | Not used in this slice. Later phases expose get-it's steps as AppPort capabilities. |
| **AuthBoundry** | Policy and authority service: tenants, delegations with resource scope, expiry and revocation, append-only audit. | Not used in this slice: there is no external access to grant. It becomes relevant when an outcome needs delegated authority. |
| **AppBoundry** | Artifact host and capability catalog, under products. | Not used. Candidate plan compiler for composition (Phase 2), subject to verification. |
| **Resolver** | `ref://` reference resolver for values, secrets and endpoints. | Not used. |
| **Intent** (FeltDB) | FeltDB's application-development planner. Not a customer request model. | Not used. The customer's request is an `OutcomeRequest` (§19). |
| **PAX** | Stateless project-evidence CLI. | Not used. |
| **Boundry Intel** | Ecosystem registry and `boundry.event/1` acceptance. | Optional telemetry only. Never get-it's store. |
| **Ledger** | A FeltKit double-entry accounting app (Appendix B). | **Reference only.** It supplies the domain vocabulary and field shapes of the bill set. Not imported, not a dependency, its database is never read, and get-it writes nothing to it. |

**New product code in get-it:**
- the commercial model;
- intake;
- the review engine;
- the deliverables package;
- delivery, acceptance and correction; and
- the acceptance criteria.

## 4. Customer journeys

### 4.1 First purchase (target; intake, quote and payment are not yet built)

1. The customer states the outcome. It is recorded as an `OutcomeRequest`.
2. Intake binds the contract's inputs:
   - home currency;
   - time zone;
   - review date;
   - optional policy values;
   - the bill set.
3. A quote states:
   - the contract version;
   - the bill count;
   - the price;
   - the turnaround;
   - the exclusions.
4. The customer accepts, and payment is recorded.
5. Fulfillment runs as stored steps (§11). While customer input is outstanding, the order is blocked and the clock
   pauses.
6. A get-it operator who did not request the review approves the exact package.
7. The package is published.
8. The customer accepts it in full or in part, or requests a correction within the window.

### 4.2 Blocked work

When the review cannot proceed (unknown vendor or account, a malformed bill to resubmit), the outcome is recorded:
- the bill's status is `blocked_pending_customer_input` or `rejected_malformed`;
- a missing-information request names exactly what is needed;
- the operator may record the order as blocked, which pauses the turnaround clock;
- after ten blocked business days, the order is cancelled or re-quoted.

## 5. Service contracts

A versioned contract is the customer-facing definition of an outcome. It is frozen by pinning its canonical digest in
`contracts/frozen.json`.
- Loading refuses content that no longer matches its pin.
- An edit is a new version.
- A retired version keeps its pin forever, and its id and version are never reused.

| Contract | Status |
|---|---|
| `svc_bill_review_payable_prep@1.0.0` | **active**, `sha256:6097d09b5f39d202412bae4e69ad94e45768829c1f9149f12cc7648863f3c637` |
| `svc_invoice_reconciliation@1.0.0` | retired 2026-11-12, never bound to an order |

### 5.1 `svc_bill_review_payable_prep@1.0.0`

The source of truth is
[`contracts/svc_bill_review_payable_prep@1.0.0.json`](../contracts/svc_bill_review_payable_prep@1.0.0.json). This
section summarises it. Where they differ, the file wins.

**Outcome.** Review the bills the customer submits, validate completeness and arithmetic, classify policy exceptions,
prepare advisory payable recommendations, and deliver an evidence-backed review package approved by a person.

**Inputs** (`get-it.bill-set/1`, Ledger-compatible):

| | Inputs |
|---|---|
| Required | `bills` (at least 1), `vendors`, `accounts`, `homeCurrency` (default USD), `timeZone`, `asOfDate` (the review date) |
| Optional | `priorBills` (for duplicate detection); `policy.documentRequiredOverMinor` (default 7500, i.e. $75); `policy.dueSoonBusinessDays` (default 5) |
| Limits | 1000 bills, 2000 vendors, 2000 accounts, 5000 prior bills, 200 lines per bill |

**Required fields:**

| Record | Required | Optional |
|---|---|---|
| vendor (a Ledger contact of kind vendor) | `id`, `name`, `active` | `paymentTermsDays`, `defaultAccountId` |
| account | `id`, `name`, `active` | `number`, `type` |
| bill | `id`, `vendorId`, `billNumber`, `billDate`, `dueDate`, `currency`, `status` (`draft` `approved` `posted` `void`), `lines`, `totalMinor` | `subtotalMinor`, `taxMinor`, `documents[{ref, kind, sha256}]`, `memo`, `submittedBy` |
| line | `description`, `accountId` (account or category), `amountMinor` | `taxMinor` |
| prior bill | `vendorId`, `billNumber` | `billDate`, `totalMinor` |

Notes on the fields:
- Amounts are integer minor units, as Ledger stores them: line `amountMinor` ≥ 1, and the other amounts ≥ 0.
- Dates are calendar dates, with `dueDate` on or after `billDate`.
- Ledger members the format does not name (`journalEntryId`, `approvedBy`, …) are ignored.
- Only `draft` bills are awaiting approval.

**Currency.** A bill in a currency other than the order's home currency:
- is classified `foreign_currency_review`;
- is reported in its own currency;
- always requires review; and
- needs a document.

get-it **never converts currencies**. Payable totals are reported per currency.

**Statuses.** Each bill gets one status: the first, in this order, for which it has an exception.

| # | Status | Exception types |
|---|---|---|
| 1 | `rejected_malformed` | `malformed_bill` |
| 2 | `blocked_pending_customer_input` | `vendor_unknown`, `account_unknown` |
| 3 | `duplicate_suspected` | `duplicate_in_set`, `duplicate_of_prior`, `near_duplicate` (same vendor, currency and total, within 3 days) |
| 4 | `arithmetic_exception` | `subtotal_mismatch`, `tax_mismatch`, `total_mismatch` (total ≠ Σ amounts + Σ taxes, exactly) |
| 5 | `foreign_currency_review` | `foreign_currency` |
| 6 | `policy_exception` | `vendor_inactive`, `account_inactive`, `terms_mismatch`, `future_dated`, `not_awaiting_approval` |
| 7 | `needs_information` | `document_missing` (over the policy threshold, or any foreign bill) |
| 8 | `ready_for_payable_approval` | none |

**Human review:**
- Every delivery needs one person's approval of the exact approval-packet digest, by an operator who did not request
  the review. Agents, services and customers cannot approve.
- A re-run or correction needs a new approval.
- A review request expires after 7 days.
- An exception is flagged for review when:
  - the bill total exceeds $500 (50000 minor units) in the home currency;
  - the bill is in a foreign currency; or
  - the exception is a suspected duplicate.
- The customer decides suspected duplicates. A decision is recorded and changes no accounting record.

**Recommendations** (advisory):
- `ready_for_payable_approval` → `approve_for_payment`.
- `rejected_malformed` → `reject_resubmit`.
- Every other status → `hold`.
- Priority:
  - `overdue`: due before the review date;
  - `due_soon`: due by the 5th business day after it;
  - `scheduled`: otherwise.

**Deliverables:**

| Deliverable | Files |
|---|---|
| Bill review results | `bill-review-results.json`, `.csv` |
| Payable recommendation | `payable-recommendation.json`, `.csv` |
| Exception list | `exceptions.json`, `.csv` |
| Missing-information requests | `missing-information-requests.json` |
| Source-document references | `source-document-references.json` |
| Evidence | `evidence.json`: every bill's input digest, all 16 checks with outcomes, the reference records used |
| Summary export | `summary.csv` |
| Approval packet | `approval-packet.json`: the contract, snapshot and output digests and the sha256 of every other file |

**Acceptance criteria:**

| Criterion | What it checks |
|---|---|
| `completeness` | one result per submitted bill |
| `traceability` | every result, exception, request, recommendation and document reference cites input digests in the snapshot |
| `recomputation` | re-review gives the delivered output exactly |
| `classification` | statuses follow the contract order; each exception agrees with a failed check |
| `no_accounting_mutation` | recommendations are advisory contract values, and every input still matches its digest |
| `package_integrity` | every file matches its sha256 in the packet |
| `reviewed` | the packet digest is approved by a person other than the requester |
| `on_time` | published by the deadline |

Every criterion except `on_time` must pass to publish. Lateness is recorded, not hidden.

**Pricing and turnaround** (assumptions carried from the revision 3 decisions):
- $250 per run including 100 bills, then $2 per additional bill.
- Turnaround is 2 business days from the first complete bill set.
- Business days are Monday–Friday excluding US federal holidays (observed), in the customer's time zone. The deadline
  is 23:59:59.999 local on the last counted day.

**Correction, partial, blocked and failed work:**
- **Correction:** within 5 business days of delivery and before acceptance, the customer may request a correction.
  get-it re-reviews (with corrected inputs if supplied) and delivers a new package, with a new approval, at no extra
  charge.
- **Partial work:** charged only when the customer accepts the completed portion, by the same pricing on the number
  of bills accepted.
- **Customer-blocked:** a business day blocked at any time does not count. After 10, the order is cancelled or
  re-quoted.
- **Failed work:** platform failures and packages failing an acceptance criterion are not charged, and a failed run is
  re-run at no charge.

**Excluded actions:**
- create, update, approve, post, pay, void or delete a bill or any accounting record;
- record or schedule a payment;
- post or reverse a journal entry;
- send email or messages to vendors;
- read or write an accounting system, database or ERP;
- convert currencies; and
- match purchase orders, quantities, unit prices or receipts.

## 6. Intake (not yet built)

Intake is deterministic. The contract's required inputs that the order has not bound become questions. Each question
has a purpose, an answer type, a default and validation. Declined optional inputs become recorded assumptions (for
example, "no prior bills supplied: duplicates are detected within the set only"). Intake ends with a completeness
report.

The bill set is an upload validated by the same `validateBillSet` the import uses, so intake and fulfillment cannot
disagree about what is valid. No credentials are ever intake answers. This outcome needs none.

## 7. Inputs and the accounting boundary

**Inputs are supplied by the customer.**
- get-it reads no accounting system and holds no accounting credentials.
- A bill set is imported as content-addressed records.
- A snapshot's digest covers the review scope and the manifest of (kind, key, digest), so re-importing the same set,
  in any order, writes nothing.

**Invalid input.**
- Invalid reference data refuses the whole import, listing every issue.
- An invalid bill is imported and reviewed as `rejected_malformed`, so the customer learns what to fix.

**The accounting boundary.** get-it never creates, updates, approves, posts, pays, voids, sends or deletes an
accounting record. This is enforced in four ways:
1. **No writer exists.** There is no connector, credential or code that writes accounting data.
2. **Refusal.** `accounting.request` (and `refuseAccountingAction` in the domain) refuses every accounting action with
   `ACCOUNTING_MUTATION_REFUSED`, for every role, and writes nothing.
3. **Function inventory.** A test fixes the app's function list, so a function such as "post bill" cannot appear
   unreviewed.
4. **Acceptance.** `no_accounting_mutation` requires advisory recommendations and unchanged inputs.

## 8. Deliverables and evidence

The package is rendered deterministically from the stored review output, so it can be regenerated and checked at any
time (`delivery.files`). The approval packet lists the sha256 of every file. Approving the packet's digest approves
those exact bytes.

Evidence links every result to:
- its input digest;
- every check run, with its outcome and detail;
- the reference records used (vendor, accounts, prior bills); and
- its exceptions.

**Limitation:** evidence is append-only by convention and content-addressed, but **not tamper-evident**. Nothing
hash-chains or signs records. The integrity check detects drift; it cannot prove who caused it.

## 9. Quoting and pricing (not yet built)

A quote is a snapshot of:
- the contract version;
- the bound inputs;
- the bill count (from the uploaded set);
- the price from `runPriceMinor`;
- the turnaround and the exclusions;
- its validity; and
- its provenance.

Pricing is a deterministic function. No metering product is introduced.

## 10. Order lifecycle

Implemented now:

```text
intake → reviewing → in_review → delivered → accepted
                                    ↘ correcting → reviewing → …
```

Target, with intake, quote and payment:

```text
draft → intake → quoted → paid → accepted_for_fulfillment → reviewing ⇄ blocked
      → in_review → delivered → delivery_accepted | correcting | cancelled
```

The order's status is a projection. The facts are its snapshots, runs, packets, approvals, block events, deliveries,
acceptances and corrections, each a separate append-only record.

## 11. Fulfillment execution: stored steps, no workflow runtime

Each step is one FeltKit mutation that commits one fact. Each is idempotent or refuses a repeat.

| Step | Fact | Idempotency |
|---|---|---|
| `imports.record` | `sourceRecords` (content-addressed), `snapshots` | same set → `duplicate` |
| `runs.reviewSnapshot` | `runs` (output, output digest, packet digest) | one run per (snapshot, contract) |
| `review.request` | `packets` (digest, expiry) | the open request is returned |
| `review.approve` | `approvals` | one per packet |
| `delivery.publish` | `deliveries` (acceptance report, deadline, on-time, correction window) | one per packet |
| `delivery.accept` / `delivery.requestCorrection` | `acceptances` / `corrections` | one per delivery |
| `orders.block` / `orders.unblock` | `blockEvents` | refused when already in that state |

Every step after import is a pure function of stored facts, so a retry recomputes the same output.

**Workflow runtime: deferred.** One is introduced only when the first outcome passes §25 in production *and* a need
appears that stored steps plus FeltKit schedules cannot meet.

## 12. Human authority

Every human checkpoint uses FeltKit's approval discipline applied to get-it's records:
- person-only;
- the requester never approves;
- bound to the exact digest;
- expiring; and
- re-checked against the stored output when decided.

AppPort approval declarations do not enforce anything, and AuthBoundry approvals cover only policy changes, so neither
is relied on.

| Role | May |
|---|---|
| `operator` (get-it staff) | open orders, import, review, request review, approve another operator's request, publish, block or unblock |
| `owner` (customer) | read, decide duplicates, accept a delivery, request a correction |
| `member` (customer) | read, decide duplicates |
| agents | nothing that needs a person |

## 13. Billing (charge computation built; invoicing not built)

An acceptance records the bills counted and the charge the contract's pricing gives. The integrity check recomputes
it. Issuing a customer invoice and recording payment are later work.

## 14. Tenancy and security

**FeltKit's in-store tenant model** (revision 3 decision):
- Each customer organization is a tenant, and get-it operators are members with the `operator` role.
- Every collection is `{ tenant: true }`.
- Every collection also declares a **required `tenantId`**, set explicitly from the session. The typechecker refuses an
  insert without it, and every unique constraint includes it.
- The integrity check verifies it.
- Tested: the same operators work in two organizations, and nothing of one is readable, writable, approvable,
  decidable or acceptable from the other.

Per-customer deployments are reserved for enterprise or regulatory requirements.

## 15. Admin and operations

Operators need queues for:
- blocked orders and the blocked-day count;
- open review requests;
- failed acceptance criteria;
- late deliveries;
- correction requests; and
- integrity problems.

All of these are queries over existing facts.

## 16. Architecture

```text
Customer UI / API (FeltKit client)
        ↓
get-it (FeltKit application)
  orders · imports · runs · review · delivery · accounting (refusal) · integrity
        ↓ pure domain (src/, no FeltKit dependency)
  bills · snapshot · review · deliverables · acceptance · pricing · calendar · money · contract · accounting
        ↓
FeltDB (through FeltKit): append-only facts, tenant-scoped
```

## 17. Core data model

Implemented collections:
- `orders`, `blockEvents`;
- `sourceRecords`, `snapshots`;
- `runs`, `packets`, `approvals`, `decisions`;
- `deliveries`, `acceptances`, `corrections`;
- `audit`.

Every collection carries `tenantId`. Target additions: `OutcomeRequest`, `IntakeSession`, `Quote`, `Payment`, `Invoice`.

## 18. Non-goals

This slice does not include:
- an accounting writeback or connector of any kind;
- autonomous financial actions;
- a workflow runtime, marketplace or provider bidding;
- purchase-order matching, quantities, unit prices or three-way matching;
- currency conversion; or
- a model in the review path.

## 19. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The customer's export is not Ledger-shaped | The format is documented in the contract. Every refusal lists its issues. A bad bill is reported, not dropped. |
| A recommendation is mistaken for an approval | Recommendations are marked `advisory: true`. Acceptance accepts get-it's review, never a bill. No function writes accounting data. |
| Duplicate detection misses history | `priorBills` is an optional input. Without it, detection is within the set, which intake will state as an assumption. |
| Tampering with stored facts | The integrity check recomputes every digest. Not tamper-evident (§8). |
| Large bill sets | Limits are in the contract (1000 bills). Behaviour near the limit is not yet load-tested. |

## 20. Acceptance tests for this slice

All are automated in `tests/`:
1. The contract digest is pinned. Edited, unfrozen and retired versions are refused.
2. Tenant isolation, with an explicit `tenantId` on every record.
3. Malformed and incomplete bills are reported with every issue. Invalid reference data refuses the import.
4. Arithmetic is exact in integer minor units. Foreign currency is never converted and always reviewed.
5. Duplicates are found in the set, against prior bills, and as near-duplicates.
6. Policy exceptions are raised for inactive vendors and accounts, payment terms, future dates, and bills not awaiting
   approval.
7. Approval is refused for agents, customers, expired requests, wrong digests and the requester.
8. Integrity catches edited inputs, outputs and approvals.
9. Re-importing the same bill set writes nothing.
10. Partial work is charged on the bills accepted.
11. Business-day deadlines respect holidays, time zones, blocked days and the correction window.
12. Every accounting action is refused for every role, and the function list is fixed.
13. Acceptance works in full and in part. A correction is accepted within the window and before acceptance, and needs
    a new approval.

## 21. Open decisions

- Intake UX for uploading the bill set: JSON as specified, or a CSV mapping to the same format.
- Payment for the first market: an operator-recorded payment against an issued invoice is the proposed default.
- Retention, deletion and export obligations for customers' financial data.
- Which FeltDB authority hosts production. Embedded local is the verified path.

## 22. Implementation sequence

1. ~~Inventory the Boundry stack~~ (done: Appendix A).
2. ~~Freeze the first contract with executable acceptance tests~~ (done: `svc_bill_review_payable_prep@1.0.0`).
3. ~~Build the review engine, package, stored-step execution, approvals, delivery, acceptance, correction, blocked
   clock and integrity~~ (done: Appendix C).
4. **Next:** add intake, quoting and delivery to the customer (Appendix C, "Next step").
5. Then add operator queues, then a second outcome.

---

## Appendix A: Evidence

The stack inventory, with file and line citations, is in
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
| ledger | 3a8bce6 |

FeltDB facts come from the published `@feltdb/core` 0.21.0.

## Appendix B: Ledger (reference only)

`rkendel1/ledger` (commit 3a8bce6) was **read, never executed or modified**. get-it does not import it, depend on it or
read its database.

What get-it takes from it:
- **Vocabulary and shapes:**
  - a vendor is a contact of kind vendor with `paymentTermsDays` and `defaultAccountId`;
  - a bill has `vendorId`, a `billNumber` unique per vendor, `billDate`, `dueDate`, `status` (`draft → approved →
    posted → void`), lines of `{description, accountId, amountMinor}` and `totalMinor`;
  - amounts are integer minor units.
- **Patterns:**
  - tenant-scoped collections that declare `tenantId`, so unique constraints are per tenant;
  - person-only gates with approver ≠ proposer, re-checked when decided;
  - an audit trail;
  - an integrity check that recomputes invariants;
  - a duplicate-detection window of a few days.

What the contract adds to Ledger's shapes:
- `currency`;
- `taxMinor` per line and per bill;
- `subtotalMinor`;
- `documents`;
- `submittedBy`.

A Ledger export maps directly, with `currency` set to the organization's base currency.

## Appendix C: Implementation status and limits

Implemented and tested by `npm test` (codegen, typecheck, then the tests on a real FeltKit 0.3.27 runtime with a fresh
FeltDB per test):

| Area | Code | Tests |
|---|---|---|
| Frozen contracts, version immutability | `contracts/`, `src/contract.ts` | `tests/contract.test.ts` |
| Integer minor-unit money | `src/money.ts` | `tests/money.test.ts` |
| Business days and deadlines | `src/calendar.ts` | `tests/calendar.test.ts` |
| Pricing and charging | `src/pricing.ts` | `tests/pricing.test.ts` |
| Ledger-compatible bill sets | `src/bills.ts`, `src/snapshot.ts` | `tests/bills.test.ts` |
| Review engine | `src/review.ts` | `tests/review.test.ts` |
| Package and acceptance criteria | `src/deliverables.ts`, `src/acceptance.ts` | `tests/acceptance.test.ts` |
| Accounting boundary | `src/accounting.ts`, `feltkit/accounting.ts` | `tests/accounting.test.ts`, `tests/app.test.ts` |
| App: tenancy, imports, runs, review, delivery, acceptance, correction, clock, integrity | `feltkit/*.ts` | `tests/app.test.ts` |

**Not verified:**
- No real customer export has been reviewed. The fixtures are hand-written in Ledger's shape.
- Behaviour near the 1000-bill limit, and the size of a stored run, are not load-tested.
- No HTTP or UI surface has been exercised. All tests call functions through FeltKit's in-process test harness.
- The turnaround clock starts at the first complete bill set, because there is no quote or payment yet.
- Late and blocked behaviour is tested by moving stored times in tests, not by waiting.

**Next step: intake, quoting and delivery.**
1. Add `OutcomeRequest` and `IntakeSession` collections, and an `intake` module:
   - `intake.start`;
   - `intake.answer` for home currency, time zone, review date and the policy values, validated against the contract's
     ranges as `orders.create` does today;
   - `intake.uploadBillSet`, reusing `buildSnapshot`/`validateBillSet` so intake and import agree; and
   - `intake.complete`, producing a completeness report and the recorded assumptions.
2. Add `Quote` (`quotes.create` from a completed intake, using `runPriceMinor` on the uploaded bill count, plus
   validity, turnaround and exclusions) and `quotes.accept` (customer owner, a person, idempotent).
3. Add `payments.record` (operator-recorded payment) that creates the order from the accepted quote. Move the clock
   start to "accepted for fulfillment and inputs complete", as the contract says.
4. Add a customer delivery view over `delivery.get` and `delivery.files`, with download of each file, and the accept,
   partial-accept and correction actions already implemented.
5. Write the tests first, in the existing style:
   - an intake answer outside the contract's range is refused;
   - a quote matches `runPriceMinor`;
   - accepting a quote twice creates one order;
   - the clock starts at fulfillment acceptance; and
   - a customer can download exactly the files listed in the approval packet.
