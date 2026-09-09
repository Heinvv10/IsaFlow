# K-015 — AP migration writes a non-existent `balance_due` column

**Claim.** Every INSERT raises 42703 and, with no savepoint, poisons the request transaction so
the whole run 500s.

**Corrected trigger.** `importAPInvoices` INSERTs `balance_due` into `supplier_invoices`
(migrationApService.ts:73). No table in the production schema has a `balance_due` column at all;
`supplier_invoices` has `balance`. Confirmed against the fixture schema:
`SELECT table_name, column_name FROM information_schema.columns WHERE column_name LIKE '%balance_due%'`
returns 0 rows. Every row therefore raises 42703, is caught by the per-row `try` (:121), counted
as `skipped`, and continues — but the transaction is already aborted, so `updateSession` at :128
raises 25P02 and the call throws. The route returns 500 and the wizard step never completes.

**Disposition: confirmed.**

**Evidence.** File unchanged 5661d6f0..ebeac9ca. RED integration test, real PostgreSQL, drives the
service inside an `als` request transaction exactly as `withAuth` does. Both assertions fail:
the column does not exist, and the run dies at `updateSession` with
`current transaction is aborted, commands ignored until end of transaction block`, stack showing
`updateSession -> importAPInvoices`.

**Reachability.** `POST /api/accounting/migration/ap-invoices`
(`withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))`), authenticated, any tenant.
The AP step of the migration wizard has never worked.

**RED test.** `tests/integration/k015-ap-migration-balance-due-column.int.test.ts` — 2 failed / 2.
Log: `docs/audits/remediation/K-015/red.log`.

**Proposed minimal fix.** Drop `balance_due` from the column list and the value list in the INSERT
at migrationApService.ts:70-86. The `balance` column is generated/derived elsewhere in this
codebase as `total_amount - COALESCE(amount_paid, 0)`; write nothing rather than inventing a
second source of truth. Apply the identical edit to K-089 in the same change.

**Historical-data impact.** None on stored rows — no INSERT ever succeeded, so no bad data exists.
The impact is absence: every tenant that ran the AP wizard step imported zero bills and saw a 500.
Read-only check for wizard sessions that recorded the failure:
```sql
SELECT company_id, id, ap_invoices_imported, errors
  FROM migration_sessions
 WHERE errors::TEXT LIKE '%balance_due%' OR (steps_completed ? 'ap_invoices') = false;
```

**Risks.** None beyond the edit itself. Also unblocks R-001/R-002, which depend on this path
being runnable.
