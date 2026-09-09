# K-009 fix — migration rollback no longer destroys pre-existing chart accounts

**Trigger.** `executeMigration` upserted `imported_from = EXCLUDED.imported_from`, so an account the
company created itself acquired the source tag whenever its `account_code` collided with an imported
one. `rollbackMigration` then deleted every row carrying that tag, in one unqualified DELETE.

**Before.** Rollback destroyed the company's own accounts (plus their CASCADE dependents), and as
soon as any tagged account carried journal lines the DELETE raised `23503` on
`gl_journal_lines_gl_account_id_fkey` — the FK is NO ACTION — aborting the entire rollback.

**After.** `imported_from` is written on INSERT only; it is absent from the `ON CONFLICT DO UPDATE
SET` list, so a NULL tag reliably means "the company's own account". The rollback DELETE additionally
skips accounts that have journal lines (`NOT EXISTS`, `company_id`-scoped on both sides) and logs the
retained count. Return shape `{ deleted }` is unchanged.

**Note on the validator's proposal.** `COALESCE(gl_accounts.imported_from, EXCLUDED.imported_from)`
does not fix this: a pre-existing account has `imported_from IS NULL`, so COALESCE still stamps it.
Omitting the column from the update list is the correction. The RED test's precondition assertion
(that `4000` ends up tagged `xero`) encoded the defect and is corrected to expect `null`.

**Files.** `src/modules/accounting/services/core/migrationExecuteService.ts` (upsert clause + rollback
predicate + retained-count log).

**Tests.** Real DB (`bun run test:integration`), 4 passed / 4:
- `tests/integration/k009-migration-rollback-deletes-existing-accounts.int.test.ts` — 2
- `tests/integration/k009-migration-rollback-adjacent.int.test.ts` — 2 (imported account posted to is
  retained not aborted; neighbour tenant untouched; second source does not re-tag)

**Mutation check** (`green.log`): restoring `imported_from = EXCLUDED.imported_from` → 2 failed;
dropping the `NOT EXISTS` guard → 1 failed; restored → 4 passed.

**Migration.** None. `tsc --noEmit` and `eslint` clean.

**Historical-data impact.** Companies that imported over an existing chart may carry mis-stamped
accounts. The upsert never rewrote `description`, so a re-stamped account is one whose description is
not the import's own string — read-only probe:
```sql
SELECT company_id, account_code, account_name, imported_from, description
FROM gl_accounts
WHERE imported_from IS NOT NULL
  AND description IS DISTINCT FROM 'Imported from ' || imported_from
ORDER BY company_id, account_code;
```
Rows returned are accounts at risk of deletion by a future rollback; clearing `imported_from` on them
is the remediation, but that is a data decision and is not done here. Accounts already lost to a past
rollback leave no row and are recoverable only from backups.

**Limits.** A genuine re-import from a second source no longer moves the tag, so rollback of the
second source will not remove accounts first seen under the first source. Accounts retained by the
new guard stay in the chart with their tag intact; a repeated rollback retains them again.
