# K-089 — AR migration writes a non-existent `balance_due` column

**Claim.** Two migration paths write a non-existent `balance_due` column; every AR insert raises
42703, is counted as skipped, and aborts the shared transaction so later statements die with 25P02.

**Corrected trigger.** `importARInvoices` INSERTs `balance_due` into `customer_invoices`
(migrationImportService.ts:136). No table in the schema has that column. Identical mechanism to
K-015: caught 42703 per row, `skipped++`, then `updateSession` at :186 raises 25P02 and the call
throws — 500.

**Disposition: confirmed. NOT a duplicate of K-015 — a sibling.** Same root cause and same
one-line remedy, but a different file, a different table and a different route
(`/api/accounting/migration/ar-invoices` vs `/ap-invoices`). Fixing K-015 does not fix this.
Fix both in one change; do not close this by closing K-015.

**Evidence.** File unchanged 5661d6f0..ebeac9ca. RED integration test, real PostgreSQL, service
driven inside an `als` request transaction. Both assertions fail: column absent, and the run dies
at `updateSession -> importARInvoices` with `current transaction is aborted`.

**Reachability.** `POST /api/accounting/migration/ar-invoices`, `withAuth` + CSRF + write access,
any authenticated tenant.

**RED test.** `tests/integration/k089-ar-migration-balance-due-column.int.test.ts` — 2 failed / 2.
Log: `docs/audits/remediation/K-089/red.log`.

**Proposed minimal fix.** Drop `balance_due` from the column and value lists in the INSERT at
migrationImportService.ts:133-147, alongside the K-015 edit.

**Historical-data impact.** None stored — no INSERT succeeded. The AR wizard step has never
imported an invoice. Same read-only session query as K-015, on `ar_invoices_imported`.

**Risks.** None beyond the edit.
