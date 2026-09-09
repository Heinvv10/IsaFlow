# K-009 fix — migration rollback no longer destroys or half-reverts the chart of accounts

**Trigger.** `executeMigration` upserted `imported_from = EXCLUDED.imported_from`, so an account the
company created itself acquired the source tag whenever its `account_code` collided with an imported
one. `rollbackMigration` then deleted every row carrying that tag in one unqualified DELETE.

**Before.** Rollback destroyed the company's own accounts, and one blocking reference aborted the
whole statement with `23503`, so rollback was unusable after a normal migration.

**After (round 1, commit 9f15c20d).** `imported_from` is written on INSERT only, so a NULL tag
reliably means "the company's own account".

**After (round 2, this commit — review findings H1, H2, M3, M4, L5, L6).**
- **H1.** `gl_accounts` is the target of 43 foreign keys, nearly all NO ACTION, so a guard naming
  `gl_journal_lines` alone still aborted on a bank account, an asset, or the trigger-maintained
  `gl_account_balances` row that outlives its journal lines. The rollback now deletes **per account
  inside its own savepoint** and treats `23503` as "retain this one". Postgres enumerates the
  blockers, so no hand-kept list can go stale, and one refusal costs one account.
- **H2.** `rollbackMigration` returns `{ deleted, retained, retainedCodes }`; the route passes it
  through, and `RollbackButton` renders the retained codes in amber instead of an unconditional
  "Rollback complete". **Decision: the imported opening-balance journal is NOT reversed** — reversing
  posted ledger entries is out of scope for this finding — and the UI now says so.
- **M3.** The conflict update carries `WHERE gl_accounts.imported_from = EXCLUDED.imported_from`, so
  a collision with an account this source did not import leaves its name and type alone too, and is
  reported through `errors[]`. `accountsImported` now counts rows actually written.
- **M4.** Retained accounts have `imported_from` set to NULL, so a later rollback of the same source
  cannot re-arm the delete once the blocking rows are gone.
- **L5/L6.** Fixtures carry a real `fiscal_periods` row, which is what makes the balance trigger fire;
  the second `count(*)` round trip is gone (retained is derived from the enumerated set).

**Files.** `src/modules/accounting/services/core/migrationExecuteService.ts` (292 lines),
`src/components/accounting/migration/WizardParts.tsx`, `pages/api/accounting/migration-rollback.ts`
(comment only), `tests/unit/services/core/migrationExecuteSubtype.test.ts` (mock now mirrors the real
`transaction` contract, plus a case for the refused upsert).

**Tests.** Real DB 4 passed / 4; mocked unit 2 passed / 2. Full unit suite with no `DATABASE_URL`:
9315 passed, 6 failed — the identical 6 failures in the same 3 files as an `origin/master` baseline
run of the same command, all pre-existing order-dependent flakes unrelated to this change (`green.log`).

**Mutation checks** (`green.log`): dropping the M3 conflict guard fails 2; replacing the savepoint
loop with the old journal-lines-only DELETE fails 1; dropping the M4 tag clear fails 2; restored
passes 4. Re-adding `imported_from = EXCLUDED.imported_from` is an equivalent mutant once the M3
guard exists, and is recorded as such rather than as a passing mutation.

**Migration.** None. `tsc --noEmit` and `eslint` clean on all three changed source files.

**Historical-data impact.** Companies that imported over an existing chart may carry mis-stamped
accounts, and may also carry accounts silently renamed or re-typed by the old upsert. The upsert
never rewrote `description`, so a re-stamped row is one whose description is not the import's own
string. Read-only probe, not run against production:
```sql
SELECT company_id, account_code, account_name, account_type, imported_from, description
FROM gl_accounts
WHERE imported_from IS NOT NULL
  AND description IS DISTINCT FROM 'Imported from ' || imported_from
ORDER BY company_id, account_code;
```
Rows returned are at risk of deletion by a future rollback; clearing `imported_from` on them is the
remediation, but that is a data decision and is not taken here. The original name and type of an
account overwritten by a past import were never recorded and are recoverable only from backups, as
are accounts already lost to a past rollback.

**Limits.** A re-import from a second source neither re-tags nor updates the account, so its rows are
skipped and reported rather than refreshed. The rollback still leaves the opening-balance journal
posted, by the decision recorded above. Retention is decided by Postgres refusing the delete, so an
account referenced only by code rather than by id (for example the consolidation chart's
`group_accounts.account_code`) is invisible to it, exactly as it is to `accountMergeReferences`.
