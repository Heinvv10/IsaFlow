# K-090 — Sage importers run recovery SQL on an aborted transaction

**Claim.** The per-row `catch` issues an UPDATE on a connection the failed insert already aborted,
raising 25P02.

**Corrected trigger.** The mechanism is real and reproducible, but not at the line cited. The
per-row `catch` at sageCustomerImportService.ts:118-127 is unreachable, because the driving SELECT
at sageCustomerImportService.ts:22-32 asks for nine columns `sage_customer_invoices` does not have
(`sage_invoice_id, sage_customer_id, client_id, due_date, subtotal, tax_amount,
outstanding_amount, status, raw_data`; the table is id, sage_id, invoice_number, customer_name,
invoice_date, total_amount, migration_status, imported_at, company_id). That SELECT raises 42703
in the OUTER `try`, and the outer handler calls `failRun` (sageMigrationService.ts:81-86), which
issues `UPDATE gl_migration_runs …` on the now-aborted request transaction. That UPDATE is the
recovery SQL that dies — and it **masks the real cause**: the operator sees
`current transaction is aborted, commands ignored until end of transaction block`, never
`column … does not exist`. Identical shape in `importSupplierInvoices`
(sageImportService.ts:500) and `importLedgerTransactions`.

**Disposition: confirmed, with the trigger moved from the per-row catch to `failRun`.**

**Evidence.** RED test drove both importers inside an `als` request transaction on real
PostgreSQL. Both fail at `failRun → src/lib/neon.ts:107` with 25P02; stack frames
`importCustomerInvoices → sageCustomerImportService.ts:134` and
`importSupplierInvoices → sageImportService.ts:500`. Log: `red.log`.

**Reachability.** `POST /api/accounting/sage-migration-action`, actions `import_ledger`,
`import_invoices`, `import_customer_invoices` (sage-migration-action.ts:73-83), `withAuth` +
write access. Reachable today by any tenant — the 42703 is guaranteed, so every call takes this
path.

**RED test.** `tests/integration/k088-k090-sage-importers-schema-unreachable.int.test.ts` —
2 failed / 2.

**Proposed minimal fix.** Make the recovery write survivable, in `failRun`
(sageMigrationService.ts:81-86): run it on its own connection (`getPool()` directly, outside the
request transaction) so the run record is marked failed and the ORIGINAL error propagates.
Wrapping it in a savepoint is not enough — the transaction is already aborted when `failRun` is
entered, so a savepoint taken there cannot help; the savepoint would have to be taken before the
statement that fails. The same treatment applies to the per-row `UPDATE … migration_status =
'failed'` recovery writes once those become reachable.

**Historical-data impact.** None written by these importers. What exists is a population of
`gl_migration_runs` rows stuck at `status = 'running'` — the run was started, the SELECT failed,
and `failRun` could not record the failure. Read-only:
```sql
SELECT company_id, run_type, started_at FROM gl_migration_runs
 WHERE status = 'running' AND started_at < NOW() - INTERVAL '1 day';
```

**Risks.** Fixing `failRun` alone changes nothing functionally — it only unmasks the 42703 that
R-021 must still resolve. That is the point: it stops the schema bug from presenting as a
transaction bug.
