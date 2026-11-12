# get-it

An outcome-driven service business: customers buy a completed outcome with an explicit contract, defined
deliverables and evidence that the work was done. It is built as a FeltKit application on the Boundry stack.

**First outcome: bill review and payable preparation.** The customer submits the supplier bills awaiting approval as
a Ledger-compatible bill set. get-it:
1. validates completeness and arithmetic;
2. classifies duplicates, foreign currency and policy exceptions;
3. prepares advisory payable recommendations; and
4. delivers an evidence-backed review package approved by a person.

get-it reads no accounting system and **never creates, approves, posts, pays, voids or sends anything** in the
customer's books.

The contract is frozen as
[`svc_bill_review_payable_prep@1.0.0`](contracts/svc_bill_review_payable_prep@1.0.0.json), pinned in
[`contracts/frozen.json`](contracts/frozen.json) at
`sha256:6097d09b5f39d202412bae4e69ad94e45768829c1f9149f12cc7648863f3c637`.

Each bill gets one status:
- `ready_for_payable_approval`
- `needs_information`
- `policy_exception`
- `arithmetic_exception`
- `duplicate_suspected`
- `foreign_currency_review`
- `rejected_malformed`
- `blocked_pending_customer_input`

The package contains:
- bill review results;
- payable recommendations;
- exceptions;
- missing-information requests;
- source-document references;
- evidence;
- a summary export; and
- an approval packet binding the sha256 of every file.

Production needs `MAILPORT_URL` for account e-mail. People verify their address before joining an organization.

**Status.** Implemented as stored FeltKit steps, with no workflow runtime:
- **Intake:** contract-driven answers, bill-set upload, a completeness report and assumptions.
- **Quoting:** an immutable quote priced by the contract.
- **Quote acceptance**, which creates the order.
- **Operator-recorded payment.** No payment provider is integrated.
- **Explicit acceptance for fulfillment.** Only this starts the turnaround clock.
- **Review**, person-only approval and publication.
- **The customer delivery boundary:** view, download of exactly the approved files, full or partial acceptance, and
  correction within the window.
- Customer-blocked time.
- An integrity check over every fact.

No accounting write is possible. **The whole customer transaction is proven over HTTP** against the running FeltKit
server, with real accounts, verified addresses, organizations, invitations and sessions (`npm run test:http`). **No
customer UI exists yet**: that is the next step. See [`docs/spec.md`](docs/spec.md), Appendix C.

**Open business issue:** a partial delivery acceptance charges less than the paid quote, and no refund, credit or
adjustment exists. Define it before real money flows.

```bash
npm ci
npm test            # codegen, typecheck, then every test (in-process and HTTP), fresh FeltDB per test
npm run test:http   # only the HTTP transaction tests, against get-it's running FeltKit server
npm run sabotage    # break each critical guard in turn; every one must fail the test that reaches it
```

- [`docs/spec.md`](docs/spec.md) is the building specification (revision 6).
- `src/` holds the pure domain, with no FeltKit dependency: bills, snapshot, intake, review, deliverables,
  acceptance, pricing, calendar, money, contract and accounting.
- `feltkit/` holds the application: tenancy, intake, quotes, payments, orders, imports, runs, review, delivery,
  accounting (refusal) and integrity.
- `contracts/` holds frozen service contracts. A change is a new version. Retired versions keep their pins.
  `npm run contract:digest` checks them.

Ledger (`rkendel1/ledger`) is a domain reference only. get-it does not import it, depend on it, read its database or
modify it.
