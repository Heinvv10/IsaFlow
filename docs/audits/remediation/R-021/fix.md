# R-021 (+ K-088, K-090): Sage supplier-invoice importer

## Defects
- **R-021.** `importSupplierInvoices` SELECTed 11 columns that `sage_supplier_invoices` has never had. Every call raised 42703, so no bill has ever been imported this way.
- **K-090.** `failRun` ran on the transaction the failure had aborted. It raised 25P02, which hid the real error.
- **K-088.** There was no duplicate guard. That did no harm while R-021 kept the importer dead, but once revived, a re-run after `resetMigration` would double-book every bill.

## Fix
The importer now reads the real columns: `sage_id, invoice_number, supplier_name, invoice_date, total_amount`.

| Field | Rule |
|---|---|
| Supplier | The one live supplier of that name, case- and whitespace-insensitive. None, or more than one, fails the row. |
| Due date | `invoice_date + payment_terms` days. NULL terms give no due date; the ageing lists the bill under "no due date". |
| Total | Must be positive. A zero or negative total (a credit note) fails the row. |
| VAT | `deriveSageVat(null, null, total)`: no VAT, and the bill carries the review note (R-089). |
| Payment | Unpaid and `approved`. |
| Idempotency | A live bill for the same supplier with the same `sage_invoice_id`, or failing that the same `invoice_number`, is linked and counted as skipped. A bill under that number with a different Sage id fails the row. The run holds `lockMigrationImport`. |

`withRunRecovery` wraps the ledger, customer, supplier and account-mapping runs. It rolls back to a savepoint taken before the body, then calls `failRun`. The real error reaches the caller. The 'failed' run row is written inside the request transaction, which withAuth rolls back with the 500, so it is not persisted; the gain is the unmasked error.

## Evidence
Tests run against the fixture database (pg16, migrations through 691):
- `tests/integration/r021-sage-supplier-import.int.test.ts`
- `tests/integration/k088-sage-supplier-import-rerun.int.test.ts`
- `tests/integration/k090-sage-import-run-recovery.int.test.ts`

Results:
- **RED on the pre-fix code** (`red.log`, taken before the review round with the earlier file layout): 9 of 9 fail.
- **GREEN:** 20 of 20 pass.
- **Mutations** (`mutations.log`): 19 mutations, all red after the review round. Two mutations survived the first round, and both were fixed:
  - **M6.** Without `company_id` on the staging SELECT, B's staged row was booked into company A's AP. The tenant test only looked in B; it now checks every company.
  - **M11.** `failRun`'s own savepoint was unreachable, because `withRunRecovery` has already restored the transaction. It was removed.
- **Unit tests:** 48 of 48 in the Sage import suites. The mocks gained `withRunRecovery`, and the supplier VAT unit test now uses the real staging row shape.

## Historical-data impact
None. No `supplier_invoices` row can have come from this path. Runs that failed before this fix can still be stuck at `status='running'` in `gl_migration_runs`:

```sql
SELECT company_id, run_type, started_at FROM gl_migration_runs
WHERE status = 'running' AND started_at < NOW() - INTERVAL '1 day';
```

This is read-only and has not been run on production.

## Not covered
- `payment_terms_type = 'end_of_month'` is ignored. No code in the repo honours it.
- `importCustomerInvoices` is still dead on a 42703. That is R-101.

## Review round 1 (two blind reviewers, general + adversarial), all findings fixed in `fbdd1d362` and the commit after it

| Finding | Fix | Proof |
|---|---|---|
| HIGH: a distinct Sage invoice with a reused number and total was linked to the earlier bill and lost. | Identity is `(supplier, sage_invoice_id)`, then the unique key `(supplier, invoice_number)`; a different Sage id under the same number fails the row. | K088N test; M16 red. |
| HIGH: a negative total was booked as an approved bill with a negative balance. | Zero and negative totals fail the row. | R021NEG tests; M12, M13 red. |
| MEDIUM: re-run protection depended on the supplier's current VAT number. | The fingerprint no longer decides identity. | K088V test (VAT number edited between runs). |
| MEDIUM: two concurrent runs left a row failed-but-linked. | `lockMigrationImport` for the run. | K088C test; M17 red. |
| MEDIUM: the due-date derivation was untested (constant 30 survived). | Tests with terms 45 and NULL. | M8 red. |
| LOW: NULL terms invented 30 days. | No due date. | R021T0 test. |
| LOW: `supplier_id` could be dropped from the existing-bill lookup. | Tests with two suppliers sharing a number, and another supplier's bill sharing a Sage id. | M14, M15 red. |
| LOW: a zero total stayed pending forever. | Failed, so it is visible. | R021NEG(0). |
| LOW: the run-row UPDATEs had no `company_id`. | `completeRun`, `failRun`, `withRunRecovery` take and use it. | M19 red. |
| LOW: K-090's outer test relied on R-101. | It triggers a failing statement directly. | k090 file. |
| LOW: empty catches in the helper; whitespace in stored names; the doc comment overstated the persisted run row. | Fixed. | R021WS test; M5 red. |
