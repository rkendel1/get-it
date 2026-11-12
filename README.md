# get-it

An outcome-driven service business: customers buy a completed outcome with an explicit contract, defined
deliverables and evidence that the work was done. It is built as a FeltKit application on the Boundry stack.

**First outcome:** supplier invoice reconciliation. A deterministic two-way match of QuickBooks Online bills against
purchase orders, operationally read-only. The contract is frozen as
[`svc_invoice_reconciliation@1.0.0`](contracts/svc_invoice_reconciliation@1.0.0.json), with its digest pinned in
[`contracts/frozen.json`](contracts/frozen.json).

**Status: Phase 0.** Implemented and tested:
- the frozen contract;
- integer-cent tolerance math;
- business-day deadlines;
- pricing and charging;
- the read-only QBO connector, which refuses mutations;
- reconciliation;
- the seven acceptance criteria; and
- the FeltKit app: tenant-scoped orders, idempotent imports, runs, review approvals, customer decisions and an
  integrity check.

There is no real QuickBooks connection, intake, payment or delivery UI yet. See [`docs/spec.md`](docs/spec.md)
Appendix C.

```bash
npm ci
npm test   # codegen, typecheck, then the tests on a real FeltKit runtime (fresh FeltDB per test)
```

- [`docs/spec.md`](docs/spec.md) is the building specification (revision 3).
- `src/` holds the domain, with no FeltKit dependency: money, tolerance, calendar, pricing, qbo, snapshot,
  reconcile, acceptance and contract.
- `feltkit/` holds the application: tenancy, collections, orders, imports, runs, review and integrity.
- `contracts/` holds frozen service contracts. A change is a new version; `npm run contract:digest` prints digests.
