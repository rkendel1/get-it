# get-it

An outcome-driven service business: customers buy a completed outcome with an explicit contract, defined
deliverables and evidence that the work was done. It is built as a FeltKit application on the Boundry stack.

**Status:** specification only. There is no code yet.

- [`docs/spec.md`](docs/spec.md) is the building specification (revision 2). It is grounded in a verified
  inventory of the Boundry stack.
- The first outcome is **supplier invoice reconciliation**: a two-way match of invoices against purchase orders
  through one read-only accounting/ERP connector. Version 1 has no writes, no payments and no email.

Next step: settle the open decisions in spec §26 (items 1–5), then freeze `svc_invoice_reconciliation@1.0.0`
and its acceptance criteria as executable tests.
