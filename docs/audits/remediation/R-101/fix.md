# R-101: Sage customer-invoice importer

## Defect
`importCustomerInvoices` SELECTed `sage_invoice_id`, `sage_customer_id`, `client_id`, `due_date`, `subtotal`, `tax_amount`, `outstanding_amount`, `status` and `raw_data`. `sage_customer_invoices` has never had any of them, so every run died on 42703 before its loop, and no customer invoice was ever imported this way. The write-back column `gl_customer_invoice_id` did not exist either, so `resetMigration('customer_invoices')` died on the same 42703. This is the AR twin of R-021.

Reach: nothing in the repo writes to any `sage_*` staging table, and on 2026-09-02 all four were empty in production (handoff 2026-09-02-0405). The importer is reachable only from the migration-action route, with staging filled some other way.

## Fix
Migration **694** adds `sage_customer_invoices.gl_customer_invoice_id UUID REFERENCES customer_invoices(id)`. It is nullable and needs no backfill.

The importer now reads `sage_id, invoice_number, customer_name, invoice_date, total_amount`.

| Field | Rule |
|---|---|
| Customer | The one live customer of that name, case- and whitespace-insensitive. None, or more than one, fails the row. |
| Due date | `invoice_date + customers.payment_terms` days. NULL terms give no due date. |
| Total | A negative total is a Sage credit note: `migration_status = 'credit_note'`, counted as skipped, and nothing is booked. A zero or non-numeric total fails the row. |
| VAT | `deriveSageVat(null, null, total)`: no VAT, and the invoice carries the review note (R-089). |
| Payment | Unpaid and `approved`. |
| Sage identity | `external_ref = sage_id`, `external_system = 'sage'`, `external_document_number` = the Sage number (migration 530). `customer_invoices` has no `sage_invoice_id`. |
| Idempotency | See below. The run holds `lockMigrationImport`. Each row runs in its own savepoint. |

`findExistingInvoice` looks for the first of two matches: a live invoice carrying this Sage id, or else any invoice under this number. It links the staged row only when that invoice is live, not cancelled, on this customer, of the same total, and carries either this Sage id or no external reference. When the invoice has no external reference, the importer adopts it once and stamps it with the Sage id. Anything else fails the row. The AR-specific cases:
- **The number is unique per company** (`uq_customer_invoices_company_number`), and soft-deleted and cancelled rows hold it too. A number held by any of those, or by another customer's invoice, fails the row cleanly. It never reaches the index as a 23505.
- **A Sage id already live on ANOTHER customer's invoice fails the row.** This happens when the customer is renamed between runs. Booking it again would put the same debt in AR twice. The supplier side (K088X) books a second bill in that case, and this side deliberately does not.

`getMigrationStatus` adds `customerInvoices.creditNotes`.

R-119's notes on this item:
- **The credit-note status:** done, as shown above.
- **The negative tax leg from `deriveSageVat` with stated figures:** can no longer occur. No staging table states a subtotal or tax, so both importers call `deriveSageVat(null, null, total)`, which returns (total, 0) for a positive total. `statedSageFigures` served only the old raw_data path, so it has been removed with its tests.

## Evidence
All runs are against the fixture database `isaflow-fixture-r112` (pg16, migrations through 694).
- `tests/integration/r101-sage-customer-import.int.test.ts` has 10 tests. `tests/integration/r101-sage-customer-import-rerun.int.test.ts` has 12.
- **RED** on the pre-fix code, before migration 694 (`red.log`): 19 of 19 failed, 17 of them on 42703. The red run predates 3 tests added after the mutation round.
- **GREEN:** 70 of 70 across the 9 suites that touch the Sage importers or migration status: both r101 files, r021, k088, k090, r089, r119, and `api/sageMigrationService` and `api/sageCustomerImportService`.
- **Mutations** (`mutations.log`): 19, all red. Three survived the first round, and each changed the code or the tests:
  - **M13:** the ORDER key was NULL for an invoice with no reference, so flipping ASC/DESC made no difference. The key is now `COALESCE(..., FALSE)`.
  - **M17:** it exposed the cross-customer double booking described above. That case is now a conflict.
  - **M19:** a soft-deleted holder of the Sage id was untested. The re-import test now covers it.
- **Unit:** 31 of 31 across the 5 Sage unit files. `sageCustomerImportVat.test.ts` now drives the real staging row shape, and it is the only gate CI runs on this path.

## Two stale tests fixed on the way
`tests/integration/api/sageMigrationService.test.ts` (B, C) and `r089-migration-run-vat-count` called `completeRun` without the `companyId` that R-021 added. They failed on master before this change, with `invalid input syntax for type integer: "NaN"` and `type uuid: "5"`. They are the only tests of `getMigrationStatus`, and this change edits that function.

## Historical-data impact
None. No `customer_invoices` row can have come from this path. Migration 694 only adds a nullable column.

## Not covered
- `payment_terms_type = 'end_of_month'` is ignored, as it is on the supplier side.
- No credit-note importer consumes `'credit_note'` rows yet.
- The migration page (`pages/accounting/sage-migration/index.tsx`) has no customer-invoice section, so `creditNotes` is exposed through the API only.
