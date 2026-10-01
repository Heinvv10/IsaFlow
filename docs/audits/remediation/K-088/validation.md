# K-088 — Sage supplier-invoice import has no idempotency guard

**Claim.** Re-running after a reset re-inserts every bill, and there is no unique index on
`supplier_invoices(company_id, invoice_number)`.

**Corrected trigger.** The index half is true — the fixture schema (production mirror) shows no
unique index on `supplier_invoices` other than the primary key, and `importSupplierInvoices`
(sageImportService.ts:406-425) INSERTs with no `ON CONFLICT` and no prior existence check. But the
claimed consequence cannot occur, because the function never reaches its row loop. The driving
SELECT at sageImportService.ts:359-368 asks for `sage_invoice_id, sage_supplier_id, due_date,
subtotal, tax_amount, outstanding_amount, status, ff_purchase_order_id, supplier_id, raw_data,
line_items` — eleven columns `sage_supplier_invoices` does not have. The live table is
(id, sage_id, invoice_number, supplier_name, invoice_date, total_amount, gl_supplier_invoice_id,
migration_status, imported_at, company_id). The first statement raises 42703 inside the outer
`try`, so no bill is ever inserted, once or twice. This is the R-021 schema mismatch, the same
condition already documented in the file's own header for `importLedgerTransactions`.

**Disposition: false-positive as stated — the defect is unreachable. The live defect on this path
is R-021 (schema mismatch); the missing idempotency guard is a latent gap to fix WITH the schema
reconciliation, not before it.**

**Evidence.** RED reachability test seeded a `pending` row using only columns that exist and
called `importSupplierInvoices` inside an `als` request transaction. It fails at
`failRun → sageMigrationService.ts:82` with `current transaction is aborted` — the 42703 from the
driving SELECT, then the outer recovery UPDATE on the poisoned transaction (that second step is
K-090). Log: `red.log`.

**Reachability.** `POST /api/accounting/sage-migration-action` action `import_invoices`
(sage-migration-action.ts:78). The route is live; the function is not.

**RED test.** `tests/integration/k088-k090-sage-importers-schema-unreachable.int.test.ts` —
2 failed / 2 (assertion 1 is K-088's).

**Proposed minimal fix.** Do not add a guard to unreachable code. When R-021 is settled and the
importer is revived, add a partial unique index on
`supplier_invoices(company_id, invoice_number) WHERE deleted_at IS NULL` and an
`ON CONFLICT (company_id, invoice_number) DO NOTHING` on the INSERT, and count the no-op as
skipped. Until then the correct action on this candidate is to fold it into R-021.

**Historical-data impact.** None. No `supplier_invoices` row can have come from this path.
Read-only confirmation: `SELECT count(*) FROM supplier_invoices WHERE sage_invoice_id IS NOT NULL;`
— expected 0.

**Risks.** If someone repairs the SELECT without adding the guard, the claimed duplicate-bill
defect becomes live immediately. Tie the two together in one change.
