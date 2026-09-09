# K-009 — migration rollback deletes pre-existing chart accounts

**Claim (audit A C13):** rollback runs an unqualified DELETE on `imported_from` with no check for
existing journal lines, "orphaning posted lines".

**Corrected trigger.** Orphaning is impossible: `gl_journal_lines_gl_account_id_fkey` has no
`ON DELETE` clause, so it is NO ACTION. The real damage is two-sided.
1. `executeMigration` upserts with `ON CONFLICT (company_id, account_code) DO UPDATE SET
   imported_from = EXCLUDED.imported_from` (`migrationExecuteService.ts:88-92`, `git show ebeac9ca`).
   An account the company created itself is silently re-stamped whenever its code collides with an
   imported code. `rollbackMigration` (`:224-228`) then deletes it — real chart-of-accounts loss,
   plus CASCADE loss of `afs_account_mappings`, `account_reporting_group_members` and
   `account_external_mapping` rows hanging off it.
2. As soon as any matched account carries journal lines — including the opening-balance journal
   this same migration posts at step 2 — the single unqualified DELETE raises 23503 and the whole
   rollback aborts. Rollback is unusable after a normal migration.

**Disposition: confirmed** (claimed mechanism corrected; the finding stands, severity intact).

**Reachability.** `POST /api/accounting/migration-rollback` →
`withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))` → `rollbackMigration(companyId, source)`
with no further guard. File unchanged between 5661d6f0 and ebeac9ca
(`git log --oneline 5661d6f0..ebeac9ca -- src/modules/accounting/services/core/migrationExecuteService.ts` empty).

**Evidence.**
- FK catalogue: `SELECT conname, pg_get_constraintdef(oid) ... confrelid='gl_accounts'::regclass`
  on the fixture DB — `gl_journal_lines_gl_account_id_fkey` is plain `REFERENCES gl_accounts(id)`.
- RED test `tests/integration/k009-migration-rollback-deletes-existing-accounts.int.test.ts`,
  2 tests / 2 failed (`docs/audits/remediation/K-009/red.log`):
  - pre-existing `4000` deleted by rollback (`expected [] to deeply equal [ '4000' ]`);
  - rollback rejects with `23503 gl_journal_lines_gl_account_id_fkey` when `4000` has a posted line.

**Proposed minimal fix** (`src/modules/accounting/services/core/migrationExecuteService.ts`):
- Stop re-stamping: change the conflict clause to
  `imported_from = COALESCE(gl_accounts.imported_from, EXCLUDED.imported_from)` so an account the
  company already owned never acquires the source tag.
- Scope the rollback DELETE to accounts with no dependent rows:
  `AND NOT EXISTS (SELECT 1 FROM gl_journal_lines jl WHERE jl.gl_account_id = gl_accounts.id)`,
  and return the skipped count so the API reports what was retained instead of throwing.

**Historical-data impact.** Any company that ran an import over an existing chart may carry
mis-stamped accounts, and any company that ran a rollback may have lost self-created accounts.
Read-only probe:
```sql
SELECT company_id, count(*) FILTER (WHERE imported_from IS NOT NULL) AS stamped
FROM gl_accounts WHERE imported_from IS NOT NULL GROUP BY company_id;
```
Deleted accounts leave no row; detect the loss instead through `gl_journal_lines` referencing
nothing (impossible under the FK) or through gaps in `account_code` sequences — practically, the
loss is only recoverable from backups, so the migration path matters more than remediation SQL.

**Risks.** Tightening the conflict clause changes upsert semantics for genuine re-imports (the
source tag stops moving between sources); acceptable, since the tag exists only to drive rollback.
