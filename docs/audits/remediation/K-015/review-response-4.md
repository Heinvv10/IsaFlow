# K-015 / K-089 — response to the blind re-review of 47ead2b2

All four findings addressed. One of them turned up a bigger problem I am registering, not fixing.

## N1 (MEDIUM) — the Sage importer's 23505 poisoned its transaction

The diagnosis is right and the fix is in: the per-record body of `importSupplierInvoices` now runs
inside `withSavepoint('sage_supplier_invoice_record')`. The `migration_status` markers for a failed
or skipped record are written OUTSIDE that savepoint, after it has rolled back, so they survive.
A refused duplicate is no longer counted as a failure at all: the document is already in IsaFlow,
so the staging row is pointed at the invoice it collided with, marked `imported`, and counted as
skipped — nothing new was created, and a re-run of the same export converges instead of reporting
a growing failure count.

**But the hazard is not reachable today, and I am not going to claim I fixed a live path.**
`importSupplierInvoices` cannot run at all on a database built from this repo's migrations. Its
first statement selects `sage_invoice_id`, `sage_supplier_id`, `due_date`, `subtotal`,
`tax_amount`, `outstanding_amount`, `status`, `ff_purchase_order_id`, `supplier_id`, `raw_data`
and `line_items` from `sage_supplier_invoices`. Migration 205 creates that table with ten columns
and 288 adds `company_id`; none of those eleven exist. Measured on the fixture:

```
ERROR:  column "sage_invoice_id" does not exist
actual columns: id, sage_id, invoice_number, supplier_name, invoice_date,
                total_amount, gl_supplier_invoice_id, migration_status,
                imported_at, company_id
```

That is the K-015 defect class — a query naming columns that do not exist — in a third service,
and it is bigger than what this branch was asked to fix: the Sage supplier-invoice import raises
42703 on its first statement for every tenant. **Registered as its own finding.** I have not fixed
it here: it needs a decision about whether the staging table gained columns that were never
migrated or the query was written against a schema that never shipped, and answering that is not a
one-line change.

The savepoint work still stands. It is correct the moment that SELECT is repaired, and leaving a
known transaction-poisoning shape in place because its caller happens to be dead would be the
wrong trade.

Because the function cannot be driven end to end, the test proves the mechanism at the level the
real database can prove it, and says so in its header: the savepoint contains the 23505 and the
follow-up status UPDATE lands; without the savepoint that same UPDATE raises 25P02; and the
violation stays recognisable through the wrapper that replaces its message.

`recurringTransactionService` is untouched, for the reason the review gives: no catch around the
insert, so nothing runs on the aborted transaction.

## N2 (LOW) — the translator discarded the pg error and its own log line

`rethrowDuplicateFingerprint` now logs the refusal itself and attaches `{ cause: err }`, so `code`
and `constraint` stay reachable. The predicate `isDuplicateFingerprintViolation` walks the cause
chain (guarding against a cycle) so a caller can branch on the violation whether it arrives raw or
wrapped — which is what the Sage catch now does. Dropping `cause` takes two tests red.

## N3 (LOW) — duplicated comment paragraph in `updateSession`

Removed. The `NOT EXISTS` note below it is kept.

## N4 (LOW) — `export { matchContact };` sat between two imports

Moved below the import block.

## Still open, unchanged

The opening-balances step and the invoice import double the AR and AP control accounts;
`customer_invoices.external_ref` has no reader; and the production pre-flight query for migration
625 is owed by whoever runs the deploy. Plus the new one above.

Not raised by the review and not touched: `sageImportService.ts` is 572 lines against the repo's
300-line ceiling. It was 526 before this branch, so it was already over; the savepoint added 46.
