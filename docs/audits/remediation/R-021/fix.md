# R-021 (+ K-088, K-090): Sage supplier-invoice importer

## Defects
- **R-021.** `importSupplierInvoices` SELECTed 11 columns that `sage_supplier_invoices` has never had. Every call raised 42703, so no bill has ever been imported this way.
- **K-090.** `failRun` ran on the transaction the failure had aborted. It raised 25P02, which hid the real error.
- **K-088.** There was no duplicate guard. That did no harm while R-021 kept the importer dead, but once revived, a re-run after `resetMigration` would double-book every bill.

## Fix
The importer now reads the real columns: `sage_id, invoice_number, supplier_name, invoice_date, total_amount`.

| Field | Rule |
|---|---|
| Supplier | The one live supplier of that name, case-insensitive. None, or more than one, fails the row. |
| Due date | `invoice_date + payment_terms` days. |
| VAT | `deriveSageVat(null, null, total)`: no VAT, and the bill carries the review note (R-089). |
| Payment | Unpaid and `approved`. |
| Idempotency | A live bill with the same supplier and duplicate fingerprint is linked and counted as skipped. |

`withRunRecovery` wraps the ledger, customer, supplier and account-mapping runs. It rolls back to a savepoint taken before the body, then calls `failRun`.

## Evidence
Tests run against the fixture database (pg16, migrations through 691):
- `tests/integration/r021-k090-sage-supplier-import.int.test.ts`
- `tests/integration/k088-sage-supplier-import-rerun.int.test.ts`

Results:
- **RED on the pre-fix code** (`red.log`): 9 of 9 fail.
- **GREEN:** 9 of 9 pass.
- **Mutations** (`mutations.log`): all 11 go red. Each one fails exactly one test. Two mutations survived the first round, and both were fixed:
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
