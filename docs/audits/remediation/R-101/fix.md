# R-101: Sage customer-invoice importer

## Defect
`importCustomerInvoices` SELECTed `sage_invoice_id`, `sage_customer_id`, `client_id`, `due_date`, `subtotal`, `tax_amount`, `outstanding_amount`, `status` and `raw_data`. `sage_customer_invoices` has never had any of them, so every run died on 42703 before its loop, and no customer invoice was ever imported this way. The write-back column `gl_customer_invoice_id` did not exist either, so `resetMigration('customer_invoices')` died on the same 42703. This is the AR twin of R-021.

Reach: nothing in the repo writes to any `sage_*` staging table, and on 2026-09-02 all four were empty in production (handoff 2026-09-02-0405). The importer is reachable only from the migration-action route, with staging filled some other way.

## Fix
Migration **694** adds `sage_customer_invoices.gl_customer_invoice_id UUID REFERENCES customer_invoices(id) ON DELETE SET NULL`. It is nullable and needs no backfill. It also re-creates the supplier link from 205 with `ON DELETE SET NULL`. `executeArchive` DELETEs old paid invoices, and a NO ACTION reference from a staging row failed the whole archive run.

The importer now reads `sage_id, invoice_number, customer_name, invoice_date, total_amount`.

| Field | Rule |
|---|---|
| Customer | The one live customer of that name, case-insensitive with the ends trimmed (inner spacing must match). None, or more than one, fails the row. |
| Due date | `invoice_date + customers.payment_terms` days. NULL terms give no due date. |
| Total | A negative total is a Sage credit note: `migration_status = 'credit_note'`, counted as skipped, and nothing is booked. A zero or non-numeric total fails the row. |
| Date | A row with no invoice date fails. Otherwise the ageing would date the debt by `created_at`. |
| VAT | `deriveSageVat(null, null, total)`: no VAT, and the invoice carries the review note (R-089). |
| Payment | Unpaid and `approved`. |
| Sage identity | `external_ref = sage_id`, `external_system = 'sage'`, `external_document_number` = the Sage number (migration 530). `customer_invoices` has no `sage_invoice_id`. |
| Idempotency | See below. The run holds `lockMigrationImport`. Each row runs in its own savepoint. |

`findExistingInvoice` looks for the first of two matches: a live invoice carrying this Sage id, or else any invoice under this number. It links the staged row only when that invoice is live and in AR (not draft, pending approval or cancelled), on this customer, of the same total, and carries either this Sage id or no external reference. When the invoice has no external reference, the importer adopts it once and stamps it with the Sage id and number. Adoption also requires the same invoice date: a monthly fee whose number, customer and amount collide is a different document. A reference from another system (e.g. `xero`) conflicts. Anything else fails the row. The AR-specific cases:
- **The number is unique per company** (`uq_customer_invoices_company_number`), and soft-deleted and cancelled rows hold it too. A number held by any of those, or by another customer's invoice, fails the row cleanly. It never reaches the index as a 23505.
- **A Sage id already live on ANOTHER customer's invoice fails the row.** This happens when the customer is renamed between runs. Booking it again would put the same debt in AR twice. The supplier side (K088X) books a second bill in that case, and this side deliberately does not.

`getMigrationStatus` adds `customerInvoices.creditNotes`.

R-119's notes on this item:
- **The credit-note status:** done, as shown above.
- **The negative tax leg from `deriveSageVat` with stated figures:** can no longer occur. No staging table states a subtotal or tax, so both importers call `deriveSageVat(null, null, total)`, which returns (total, 0) for a positive total. `statedSageFigures` served only the old raw_data path, so it has been removed with its tests.

## Evidence
All runs are against the fixture database `isaflow-fixture-r112` (pg16, migrations through 694).
- `tests/integration/r101-sage-customer-import.int.test.ts` has 11 tests, `tests/integration/r101-sage-customer-import-rerun.int.test.ts` has 19, and `tests/integration/r101-sage-archive-link.int.test.ts` has 1.
- **RED** on the pre-fix code, before migration 694 (`red.log`): 19 of 19 failed, 17 of them on 42703. The red run predates 3 tests added after the mutation round.
- **GREEN:** 79 of 79 across the 11 suites that touch the Sage importers, migration status or archive: the three r101 files, r021, k088, k090, r089, r119, k071, and `api/sageMigrationService` and `api/sageCustomerImportService`.
- **Mutations** (`mutations.log`): 24 code mutations and 2 FK mutations, all red. Three survived the first round, and each changed the code or the tests:
  - **M13:** the ORDER key was NULL for an invoice with no reference, so flipping ASC/DESC made no difference. The key is now `COALESCE(..., FALSE)`.
  - **M17:** it exposed the cross-customer double booking described above. That case is now a conflict.
  - **M19:** a soft-deleted holder of the Sage id was untested. The re-import test now covers it.
- **Unit:** 31 of 31 across the 5 Sage unit files. `sageCustomerImportVat.test.ts` now drives the real staging row shape, and it is the only gate CI runs on this path.

## Review round 1 (Opus general + Opus adversarial)
| Finding | Fix | Proof |
|---|---|---|
| HIGH (adv. REPRO1): a DRAFT or pending-approval invoice was adopted. The row said imported, but AR was short. | Only an invoice in AR (approved, sent, paid, partially paid, overdue) links. | Draft and pending-approval cases added. M21 goes red. |
| HIGH (adv. REPRO2): a different invoice with the same number, customer and total was adopted. | Adoption also requires the same `invoice_date`. | R101DT test. M23 goes red. |
| HIGH (adv. REPRO4): 694's FK blocked `executeArchive`. The supplier link from 205 had the same defect. | Both links are now `ON DELETE SET NULL`. | `r101-sage-archive-link.int.test.ts`. Each link re-created as NO ACTION turns it red. |
| MEDIUM (adv. REPRO3): an undated row booked an undated approved invoice. | The row fails. | R101ND test. M24 goes red. |
| LOW (general): the non-Sage external_ref branch was untested. | Test with `external_system='xero'` under the same ref string. | M20 goes red. |
| LOW (general): the NULL sage_id path was unpinned. | Test: it imports under `SAGE-<staging id>` with no reference, and a re-run links it. | Test added. |
| LOW (general): adoption did not stamp `external_document_number`. | COALESCE-stamped. | M22 goes red. |
| LOW (both): "whitespace-insensitive" was false. | The docs and code comment now say "case-insensitive, ends trimmed". Inner spacing must match, which fails safe, like the supplier side. | Doc only. |
| LOW (general): stale R-021/R-119 lines in .claude.md. | Annotated. | — |

## Two stale tests fixed on the way
`tests/integration/api/sageMigrationService.test.ts` (B, C) and `r089-migration-run-vat-count` called `completeRun` without the `companyId` that R-021 added. They failed on master before this change, with `invalid input syntax for type integer: "NaN"` and `type uuid: "5"`. They are the only tests of `getMigrationStatus`, and this change edits that function.

## Historical-data impact
None. No `customer_invoices` row can have come from this path. Migration 694 only adds a nullable column.

## Not covered
- `payment_terms_type = 'end_of_month'` is ignored, as it is on the supplier side.
- No credit-note importer consumes `'credit_note'` rows yet.
- The migration page (`pages/accounting/sage-migration/index.tsx`) has no customer-invoice section, so `creditNotes` is exposed through the API only.
