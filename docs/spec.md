# get-it: Outcome-Driven Service Business

## Implementation-Oriented Building Specification

**Status:** Revision 6. The first service is `svc_bill_review_payable_prep@1.0.0`, which is **frozen** and
unchanged in this revision.
**Date:** 2026-11-12
**Audience:** Product, platform, fulfillment, security and operations
**Supersedes:** Revisions 1–5

### Changes from revision 5: the customer transaction is proven over HTTP

| # | Change | Why (what the HTTP tests showed) |
|---|---|---|
| 1 | **The whole customer transaction runs over HTTP** against get-it's running FeltKit server (FeltKit's own `startServer`) with real password accounts, verified addresses, organizations created and joined through FeltKit's tenancy endpoints, and server-issued sessions. `tests/http-transaction.test.ts`. | 66 in-process tests proved that functions work, not that a customer can buy. |
| 2 | **Account e-mail is declared** (`auth.accounts.email`). | Over HTTP nobody could verify an address, so nobody could accept an invitation and join an organization. In production it requires `MAILPORT_URL`. |
| 3 | **`intake.get` returns the intake's quote** (id, digest, price, validity, and the order once accepted). | A customer had no way to discover the quote they are asked to accept. Extending an existing function, not a new one. |
| 4 | **Internal records are operator reads.** `runs.get`, `imports.list`, `review.listPackets`, `review.listApprovals` and `integrity.check` need `runs.read`, `imports.read`, `review.read` or `integrity.read`, which only operators hold. | Customer roles could read run authors, snapshot importers, approvers and requesters. Customers see the delivery through `delivery.view` and `delivery.download`. |
| 5 | **Acceptance and correction records store the delivered `packetDigest`**, and the integrity check verifies it. | The digest was checked at the call but not recorded, so the evidence could not show which package was accepted or corrected. |
| 6 | **Sabotage checks are a committed script** (`npm run sabotage`): 15 guards, each broken in turn, each required to fail the test that reaches it. | Re-runnable evidence, not a one-off. |

### Changes from revision 4

| # | Change | Where |
|---|---|---|
| 1 | **Intake exists.** Answers are validated by rules read from the contract. The bill set is uploaded through the same validator as import. Required inputs block completion. Declined, unanswered or unsupplied optional inputs become durable assumptions. Completion records a deterministic report, the contract version and its digest. | §6 |
| 2 | **Quoting exists.** One immutable quote per completed intake, priced by `runPriceMinor`. Its digest covers every commercial term. | §9 |
| 3 | **Quote acceptance creates the order**: owner-only, person-only, bound to the quote digest, idempotent. It does not start fulfillment. | §9, §10 |
| 4 | **Payment is operator-recorded.** No payment provider is integrated. One payment per quote, for exactly the quoted amount. Payment enables the order but does not start fulfillment. | §13 |
| 5 | **Fulfillment starts only at explicit acceptance** (`orders.acceptForFulfillment`), which verifies payment, complete inputs, required grants (none for this contract) and the contract digest. **The turnaround clock starts there**, no longer at the first bill set. | §10, §11 |
| 6 | **Customer delivery boundary.** `delivery.view` and `delivery.download` give tenant-scoped, permission-checked access to exactly the approved package's files. Acceptance and correction now name the delivered package digest. | §8 |
| 7 | `orders.create` is removed: an order exists only through intake → quote → acceptance. | §11 |

The contract is unchanged, because no test found it internally inconsistent:
- Its optional `policy.*` inputs carry no `source`. Intake reads that as answered, because only inputs whose source is
  the customer bill set are uploaded (§6).
- It starts the turnaround "when the first complete bill set is recorded for the order". That recording now happens
  at acceptance for fulfillment, so the contract's words and the clock agree. A test pins this.

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

**What exists today:**
- intake;
- quoting;
- quote acceptance;
- operator-recorded payment;
- explicit acceptance for fulfillment;
- review, human approval and publication;
- customer view, download, acceptance and correction.

All of it is proven end to end **over HTTP** against the running FeltKit server, with real accounts and sessions
(revision 6), as well as by in-process tests. **No customer UI exists yet.** No payment provider is integrated, and no
accounting write is possible.

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

### 4.1 First purchase (implemented as functions; no UI)

1. The customer starts an intake (`intake.create`), stating the outcome. It is recorded verbatim as an
   `OutcomeRequest`.
2. The customer answers what the contract needs (`intake.answer`): home currency, time zone, review date, and
   optionally the policy values. They upload the bill set (`intake.uploadBillSet`).
3. `intake.complete` refuses while a required input is missing. Otherwise it records the completeness report and every
   assumption.
4. An operator quotes the completed intake (`quotes.create`): bill count, price, currency, assumptions, turnaround,
   validity.
5. The customer's owner accepts the exact quote (`quotes.accept`). This creates the order, `awaiting_payment`, bound
   to the intake's answers.
6. An operator records the customer's payment (`payments.record`). The order becomes `paid`.
7. An operator accepts the order for fulfillment (`orders.acceptForFulfillment`). This records the intake's bill set
   as the order's first snapshot, and **the turnaround clock starts** at that same instant.
8. Review, approval by a second operator, and publication (§11).
9. The customer views the delivery (`delivery.view`), downloads its files (`delivery.download`), and accepts it in full
   or in part, or requests a correction within the window.

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
- Turnaround is 2 business days from "the first complete bill set recorded for the order" (the contract's words). That
  bill set is recorded at acceptance for fulfillment, so the clock starts there and not at intake, quote or payment.
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

## 6. Intake

All intake rules are read from the frozen contract (`src/intake.ts`). None are restated elsewhere.

| Rule | Source |
|---|---|
| Which inputs exist | `inputs.required` and `inputs.optional` |
| Answered or uploaded | an input whose `source` is the customer bill set (`bills`, `vendors`, `accounts`, `priorBills`) is uploaded; every other input is answered |
| How an answer is validated | its `kind` (`iso-4217`, `iana-time-zone`, `iso-date`, `integer` with the contract's `min`/`max`). An unknown kind is a contract error, never a pass. |
| What blocks completion | every required input |
| What an absent optional input means | an assumption: `declined`, `not_answered` or `not_supplied`, with the contract default when it has one |

Facts, each tenant-scoped with an explicit `tenantId`:
- `outcomeRequests`;
- `intakeSessions` (bound to the contract key and digest);
- `intakeAnswers` (append-only; the latest per input wins);
- `inputBindings` (the uploaded bill set's manifest; the latest binds);
- `intakeCompleteness` (one per intake).

Behaviour:
- **Refused answers:**
  - an out-of-range or wrong-type value;
  - an unknown input;
  - a bill-set input given as an answer;
  - a declined required input;
  - a session of another tenant (not found);
  - a caller without `intake.write`.
- **The bill set** goes through `addressBillSet`, the same function `buildSnapshot` uses for imports, so intake and
  import accept identical shapes. Uploading an identical set again writes nothing.
- **The completeness report** is a pure function of the contract, the answers and the bill set, with no times or
  actors. The same inputs give the same report digest, whatever the order of answers or records. Completion records
  that digest, the contract version and digest, the bindings and the assumptions.
- **After completion**, answers and uploads are refused (`INTAKE_CLOSED`).
- **Intake creates no order and starts no clock.**

## 7. Inputs and the accounting boundary

**Inputs are supplied by the customer**, through intake (and, for corrections, `imports.record` on an order in
fulfillment).
- get-it reads no accounting system and holds no accounting credentials.
- A bill set is stored as content-addressed records, shared within the tenant: identical content is stored once.
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

## 8. Deliverables, evidence and the customer boundary

The package is rendered deterministically from the stored review output, so it can be regenerated and checked at any
time. The approval packet lists the sha256 of every file. Approving the packet's digest approves those exact bytes.

Evidence links every result to:
- its input digest;
- every check run, with its outcome and detail;
- the reference records used (vendor, accounts, prior bills); and
- its exceptions.

**The customer boundary** (`delivery.view`, `delivery.download`, `delivery.accept`, `delivery.requestCorrection`):

| | |
|---|---|
| Who | members of the organization with `delivery.read`. Another tenant's order reads as absent. A non-member is refused by permission. |
| What the view shows | order status and price; the turnaround clock; the latest delivery's files (name, sha256, bytes), summary, the pass/fail of each of the eight acceptance criteria, evidence references (snapshot and output digests, each bill's input digest), deadline, on-time, correction window, acceptance or correction; unresolved items (undecided customer questions, missing-information requests) |
| What it never shows | operator identities, approval records, publisher, run output records, other tenants |
| Downloads | exactly one file listed in the approval packet (or the packet itself), regenerated from the stored output and refused if it no longer matches its sha256 |
| Acceptance, correction | each names the delivered `packetDigest`, so the customer acts on exactly what they were shown. A correction is a separate record; the delivery never changes. |

**Limitation:** evidence is append-only by convention and content-addressed, but **not tamper-evident**. Nothing
hash-chains or signs records. The integrity check detects drift; it cannot prove who caused it.

## 9. Quoting and quote acceptance

`quotes.create` (operator) quotes a completed intake, once. The quote records:
- the contract key and digest;
- the intake's report digest;
- the bill count;
- `priceMinor = runPriceMinor(billCount)`;
- the currency (the contract's commercial currency, USD);
- the pricing terms;
- the intake's assumptions;
- the turnaround in business days; and
- `validUntil` (14 days: an operating term recorded on the quote, not a contract term).

Its `digest` covers every one of these. **Quotes are immutable.** No function changes one, a second `quotes.create`
returns the same quote, and the integrity check recomputes the digest and the price.

`quotes.accept` (customer `owner`, a person) names the quote digest:
- It refuses a wrong digest, an expired quote, or a quote whose content no longer matches its digest.
- Accepting again returns the same acceptance and order.
- Acceptance creates the order (`awaiting_payment`), bound to the intake's answers.
- **It does not start fulfillment.**

## 10. Order lifecycle

```text
intake (no order) → quote → quotes.accept → awaiting_payment → payments.record → paid
  → orders.acceptForFulfillment → accepted_for_fulfillment   ← the turnaround clock starts here
  → reviewing → in_review → delivered → delivery_accepted
                                 ↘ correcting → reviewing → …
```

The order's status and `clockStartedAt` are a projection of its facts:
- quote acceptance, payment and fulfillment acceptance;
- runs, packets and approvals;
- deliveries, acceptances and corrections; and
- block events.

The integrity check verifies that the clock started exactly at the recorded fulfillment acceptance. Review and import
are refused (`NOT_IN_FULFILLMENT`) until the order is accepted for fulfillment.

## 11. Fulfillment execution: stored steps, no workflow runtime

Each step is one FeltKit mutation that commits one fact. Each is idempotent or refuses a repeat.

| Step | Fact | Idempotency |
|---|---|---|
| `intake.create` | `outcomeRequests`, `intakeSessions` | each call is a new request |
| `intake.answer` | `intakeAnswers` | latest per input wins; refused after completion |
| `intake.uploadBillSet` | `sourceRecords` (content-addressed), `inputBindings` | same set → `duplicate` |
| `intake.complete` | `intakeCompleteness` | one per intake |
| `quotes.create` | `quotes` | one per completed intake |
| `quotes.accept` | `quoteAcceptances`, `orders` | one per quote |
| `payments.record` | `payments` | one per quote; same idempotency key and terms → the payment |
| `orders.acceptForFulfillment` | `fulfillmentAcceptances`, the order's first `snapshots` (and its clock) | one per order |
| `imports.record` (corrections) | `sourceRecords`, `snapshots` | same set → `duplicate` |
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
| everyone in an organization | read their intake (including its quote), quote, order and clock, and the customer delivery view and downloads |
| `operator` only | internal reads: snapshots, runs, review packets and approvals, payments, the integrity report |
| `operator` (get-it staff) | intake; quote; record a payment (a person); accept for fulfillment (a person); import corrections; review; request review; approve another operator's request; publish; block or unblock. Never accept a quote or a delivery for the customer. |
| `owner` (customer) | intake; accept a quote (a person); decide duplicates; accept a delivery; request a correction; read |
| `member` (customer) | intake; decide duplicates; read |
| agents | nothing that needs a person: approval, quote acceptance, payment, fulfillment acceptance, delivery acceptance, correction |

## 13. Payment and billing

**Payment is operator-recorded. No payment provider is integrated.** `payments.record` is run by an operator, who must
be a person. It records:
- the amount and currency, which must equal the quote's;
- the method (`bank_transfer`, `check`, `card_offline`, `cash`, `other`) and reference;
- the operator and the time;
- the quote digest; and
- an idempotency key.

There is one payment per quote. Recording again with the same key and terms returns it, and anything else is a
conflict.

**Payment enables the order (`paid`) and does not accept it for fulfillment.** This is the customer paying get-it for
the service. It is not an accounting action on the customer's books, which get-it never takes.

An acceptance of a delivery records the bills counted and the charge the contract's pricing gives. The integrity
check recomputes it.

**Not built:**
- issuing a customer invoice;
- refunds and credits;
- reconciling the quote price with delivery charges (a partial acceptance charges less than the quote).

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
- `outcomeRequests`, `intakeSessions`, `intakeAnswers`, `inputBindings`, `intakeCompleteness`;
- `quotes`, `quoteAcceptances`, `payments`, `fulfillmentAcceptances`;
- `orders`, `blockEvents`;
- `sourceRecords`, `snapshots`;
- `runs`, `packets`, `approvals`, `decisions`;
- `deliveries`, `acceptances`, `corrections`;
- `audit`.

Every collection carries `tenantId`. Target additions: `Invoice`, `Refund`.

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
14. Intake answers are refused when out of the contract's range, of the wrong type, unknown, a bill-set field, a
    declined required input, or from another tenant.
15. Re-uploading the same bill set is idempotent. Intake cannot complete with required inputs missing (each is named).
    Declined optional inputs become assumptions. The completeness report is deterministic.
16. A quote equals `runPriceMinor` for the bill count, and its terms and assumptions are immutable.
17. Quote acceptance is owner-only, person-only and digest-bound. Accepting twice creates one order. An expired quote
    is refused.
18. Payment is recorded once, by an operator person, for the quoted amount. It does not start fulfillment.
19. The clock starts only at fulfillment acceptance, which requires payment and an operator person. Blocking still
    pauses it.
20. Customer delivery access is tenant-scoped and permission-checked. It exposes nothing internal. Downloads are
    exactly the packet's files. Acceptance and correction are bound to the delivered digest. A correction never
    changes the delivery.
21. No new accounting mutation function: the function list is fixed, and none is an accounting action.

## 21. Open decisions

- Intake UX for uploading the bill set: JSON as specified, or a CSV mapping to the same format.
- **Partial-acceptance settlement (must be decided before real money flows).** Today the customer pays the full
  quote before fulfillment, while a partial acceptance records a smaller charge (`runPriceMinor` of the bills
  accepted). Nothing reconciles the difference: no refund, credit or adjustment exists. Partial acceptance must not be
  treated as full-price settlement. Define the adjustment, refund or credit lifecycle first.
- **Operator provisioning.** Operators join a customer's organization only when the customer's owner invites them
  (FeltKit invitations). A platform-level way to assign get-it staff to customer organizations does not exist yet.
- Retention, deletion and export obligations for customers' financial data.
- Which FeltDB authority hosts production. Embedded local is the verified path.

## 22. Implementation sequence

1. ~~Inventory the Boundry stack~~ (done: Appendix A).
2. ~~Freeze the first contract with executable acceptance tests~~ (done: `svc_bill_review_payable_prep@1.0.0`).
3. ~~Build the review engine, package, stored-step execution, approvals, delivery, acceptance, correction, blocked
   clock and integrity~~ (done: Appendix C).
4. ~~Add intake, quoting, operator-recorded payment, fulfillment acceptance and customer delivery access~~ (done:
   revision 5).
5. ~~Prove the customer transaction over HTTP~~ (done: revision 6).
6. **Next:** the customer UI, as a FeltKit client over the existing functions (Appendix C, "Next step").
7. Then define partial-acceptance settlement, then payment-provider integration, invoicing and refunds.

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
FeltDB per test, through FeltKit's in-process test harness):

| Area | Code | Tests |
|---|---|---|
| Frozen contracts, version immutability | `contracts/`, `src/contract.ts` | `tests/contract.test.ts` |
| Integer minor-unit money | `src/money.ts` | `tests/money.test.ts` |
| Business days and deadlines | `src/calendar.ts` | `tests/calendar.test.ts` |
| Pricing and charging | `src/pricing.ts` | `tests/pricing.test.ts` |
| Ledger-compatible bill sets | `src/bills.ts`, `src/snapshot.ts` | `tests/bills.test.ts` |
| Intake rules from the contract | `src/intake.ts` | `tests/intake.test.ts` |
| Review engine | `src/review.ts` | `tests/review.test.ts` |
| Package and acceptance criteria | `src/deliverables.ts`, `src/acceptance.ts` | `tests/acceptance.test.ts` |
| Accounting boundary | `src/accounting.ts`, `feltkit/accounting.ts` | `tests/accounting.test.ts`, `tests/app.test.ts` |
| Intake, quotes, payment, fulfillment acceptance | `feltkit/intake.ts`, `quotes.ts`, `payments.ts`, `orders.ts` | `tests/commerce.test.ts` |
| Customer delivery boundary | `feltkit/delivery.ts` | `tests/delivery-view.test.ts` |
| Tenancy, imports, runs, review, delivery, clock, integrity | `feltkit/*.ts` | `tests/app.test.ts` |

**Verified over HTTP** (`npm run test:http`, `tests/http-transaction.test.ts`, 4 tests), against get-it's running
FeltKit server with real accounts:
- **Identities:**
  - owner and member;
  - Operator A (fulfils);
  - an Acme reviewer operator (approves A's work);
  - Operator B (Globex only);
  - a verified non-member;
  - an anonymous caller.
- **The full path:** outcome request → answers → bill set → completion → quote (created by the operator, found by the
  customer through `intake.get`) → owner's acceptance → operator-recorded payment → acceptance for fulfillment →
  review → approval by a second operator → publication → view and download of every packet file → a correction bound
  to the delivered digest → re-import, re-review, re-approval, re-publication → the owner's acceptance of the
  corrected digest.
- **Refused:**
  - Operator B, the non-member and anonymous callers on every Acme resource;
  - members accepting quotes or deliveries;
  - customers fulfilling, paying or publishing;
  - operators accepting for the customer;
  - self-approval;
  - substituted quote and delivery digests;
  - payment amounts other than the quote;
  - downloads outside the packet (including path-like names).
- **No duplicate economic effects:** exactly one quote acceptance, order, payment, fulfillment acceptance, delivery
  acceptance and correction, despite repeated calls.
- **The clock:** the order's clock and its first snapshot both carry the fulfillment-acceptance instant. Payment
  leaves the clock paused.
- **Customer responses:** no operator ids and no approval, publication, recording or import metadata, across every
  customer-readable query and download.

**Sabotage** (`npm run sabotage`): 15 guards, each broken in turn. Every one fails the test that reaches it.

**Not verified:**
- **No customer UI exists.** The HTTP tests use bearer-token sessions. Cookie sessions and CSRF (what a browser
  client uses) are FeltKit's and are not exercised here.
- **Account e-mail** runs on FeltKit's in-memory development mail. Production needs `MAILPORT_URL`, and no real mail
  has been sent.
- **No payment provider.** Payments are operator-recorded. Nothing checks that money actually arrived.
- **No real data.** No real customer or Ledger export has been reviewed. The fixtures are hand-written in Ledger's
  shape.
- **Scale.** Behaviour near the 1000-bill limit and the size of a stored run are not load-tested.
- **Time-based behaviour** (quote expiry, review-request expiry, lateness, the correction window) is tested in-process
  by moving stored times.
- **Partial-acceptance settlement** is undefined (§21).

**Next step: the customer UI.** A FeltKit client over the functions the HTTP tests prove, with no new server
function. It should follow the business:
1. Describe what you want done: `intake.create`.
2. Answer the questions and provide the bill set, seeing exactly what is still missing: `intake.answer`,
   `intake.uploadBillSet`, `intake.get` (live completeness report).
3. See exactly what you will receive and on what assumptions; review price, scope, assumptions and timing:
   `intake.get` → `quotes.get`.
4. Purchase: `quotes.accept`. Payment stays operator-recorded until a provider is integrated.
5. Track fulfillment: `orders.get`, `orders.clock`, `delivery.view`.
6. Inspect and download results: `delivery.view`, `delivery.download`.
7. Accept, or request a correction: `delivery.accept`, `delivery.requestCorrection`.

The UI should be verified in a browser against the running server (cookie sessions, CSRF), with the HTTP refusals
re-asserted through it.
