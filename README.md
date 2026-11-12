# get-it

An outcome-driven service business: customers buy a completed outcome with an explicit contract, defined
deliverables and evidence that the work was done. It is built as a FeltKit application on the Boundry stack.

**What a customer does:** say what they need done, in their own words, with no category to pick. get-it keeps the
request exactly as written, lists it, takes details, files and links, and a person scopes it honestly. The customer
sees one of these states:
- submitted;
- more information needed;
- under review;
- needs an outside professional;
- not something we can do right now;
- a service offered.

**What can be bought today:** one service, end to end: bill review and payable preparation. The customer submits the
supplier bills awaiting approval as a Ledger-compatible bill set. get-it validates them, classifies exceptions,
prepares advisory payable recommendations, and delivers an evidence-backed package approved by a person. It reads no
accounting system and **never creates, approves, posts, pays, voids or sends anything** in the customer's books.

Its contract is frozen as
[`svc_bill_review_payable_prep@1.0.0`](contracts/svc_bill_review_payable_prep@1.0.0.json), pinned in
[`contracts/frozen.json`](contracts/frozen.json) at
`sha256:6097d09b5f39d202412bae4e69ad94e45768829c1f9149f12cc7648863f3c637`.

Every other task stays a request that a person scopes. Nothing becomes purchasable until it enters a real service
with a frozen contract.

**Status:**
- **Verified in a real browser** against the running FeltKit server and the production build: the task-first journey
  and the full bill-review purchase, correction and acceptance.
- **Verified over HTTP and in-process tests:** everything behind it.
- **Payment:** operator-recorded; no payment provider.
- **Open business issue:** a partial delivery acceptance charges less than the paid quote, and no refund or credit
  exists yet.

```bash
npm ci
npm test            # codegen, typecheck, then every test (in-process and HTTP), fresh FeltDB per test
npm run test:http   # only the HTTP transaction tests, against get-it's running FeltKit server
npm run test:browser  # the browser tests (Chromium via Playwright, production build, real server)
npm run dev         # feltkit dev: the app at http://localhost:3000
npm run sabotage    # break each critical guard in turn; every one must fail the test that reaches it
```

- [`docs/spec.md`](docs/spec.md) is the building specification (revision 7).
- `src/` holds the pure domain, with no FeltKit dependency: tasks, bills, snapshot, intake, review, deliverables,
  acceptance, pricing, calendar, money, contract and accounting.
- `feltkit/` holds the application: tenancy, tasks, intake, quotes, payments, orders, imports, runs, review,
  delivery, accounting (refusal) and integrity.
- `web/` holds the customer interface, a FeltKit React client. `tests/browser*.test.ts` drive it in Chromium.
- `contracts/` holds frozen service contracts. A change is a new version. Retired versions keep their pins.
  `npm run contract:digest` checks them.

Ledger (`rkendel1/ledger`) is a domain reference only. get-it does not import it, depend on it, read its database or
modify it.
