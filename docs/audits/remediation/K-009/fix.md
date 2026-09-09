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

**After (round 3 — re-review findings M7, L8, L9, L10, L11).**
- **M7.** `postOpeningBalances` resolved each account by code alone, so the source's opening balance
  was posted onto the very account the M3 guard had refused to touch — the operator was told "left
  unchanged" and got a journal line against their house account. The lookup now carries
  `AND imported_from = ${source}`, so a skipped account is unresolvable and falls into the existing
  "refuse the whole journal" path. Half a trial balance is an out-of-balance chart, so refusing all
  of it is the only safe answer.
- **L8.** The per-account DELETE carries `RETURNING id` and `deleted` counts rows actually removed. A
  candidate that returns none — deleted concurrently, or hidden by an RLS `USING` clause — is
  reported as retained rather than counted as a deletion this rollback performed.
- **L9.** A new test runs one rollback through an ALS-bound client inside `BEGIN`, so `withSavepoint`
  takes the savepoint path rather than its no-transaction degradation, and asserts the transaction is
  still usable after the 23503 by issuing another query on the same client.
- **L10.** Documented under Limits below rather than fixed: untagging a retained account discards its
  provenance.
- **L11.** A set-based DELETE is attempted first inside one savepoint; the per-account loop runs only
  when that raises 23503, so the common case costs one round trip instead of three per account.

**After (round 4 — re-review findings M12, L13, L14).**
- **M12.** The M4 untag and the M7 scoping combined to make the natural recovery workflow — roll back,
  fix the source file, re-import — refuse the whole opening trial balance whenever anything had been
  retained, and neither message named the cause. Both refusals now do. `postOpeningBalances`
  distinguishes "no GL account was created" from "the account exists and this import does not own it",
  and the upsert's own message says the code may have been released by a partial rollback and what to
  do about it. Re-adoption is deliberately NOT automatic: an untagged account is indistinguishable
  from one the company created itself, which is the defect this whole finding started as.
- **L13.** The set-based fast path no longer assumes it removed every candidate. Rows the DELETE did
  not return are treated as retained and untagged through the same tail as the loop's, so a
  concurrent delete or an RLS-hidden row cannot leave an armed tag behind a "clean" report.
- **L14.** The stale "all three changed source files" line is corrected below.

**After (round 5 — re-review nits L15, L16).**
- **L15.** The re-import test performed its own import, blocker and partial rollback on its own
  company instead of reading the state an earlier test left on a shared one. It passes alone under a
  `-t` filter, so a reorder can no longer turn it into a confusing failure.
- **L16.** `postOpeningBalances` collected the missing codes and the not-owned ones into one refusal
  instead of throwing on the first bucket. An import with both no longer sends the operator round the
  loop to meet the second message only after fixing the first.

**Files.** `src/modules/accounting/services/core/migrationRollbackService.ts` (new, 118 lines — the
rollback moved out of `migrationExecuteService.ts` to stay under the 300-line cap, and is re-exported
from it so no caller changed), `migrationExecuteService.ts` (229 lines),
`migrationOpeningBalanceService.ts`, `services/core/.claude.md` + its `AGENTS.md` mirror,
`src/components/accounting/migration/WizardParts.tsx`, `pages/api/accounting/migration-rollback.ts`
(comment only), `tests/unit/services/core/migrationExecuteSubtype.test.ts` (mock now mirrors the real
`transaction` contract, plus a case for the refused upsert).

**Tests.** Real DB 7 passed / 7; mocked unit 9 passed / 9. Full unit suite with no `DATABASE_URL`, run
twice: 9321 passed / 2 failed and 9313 passed / 10 failed (`green.log`). The failing set is unstable
across runs on both this branch and an `origin/master` baseline, always drawn from the same pool of
bank-allocation, cash-flow and tracker tests. Every one of them passes in isolation here and none
imports migration code.

**Mutation checks** (`green.log`, round 4, against the 7-test real-DB suite): dropping the M3 conflict
guard fails 4; restoring the journal-lines-only DELETE fails 3; dropping the M4 tag clear fails 4;
dropping the M7 ownership check fails 2; collapsing the M12 message back into "no GL account was
created" fails 2; restored passes 7; throwing on the missing codes before checking the not-owned ones (the L16
regression) fails 1 mocked unit test. Two mutants are equivalent by construction and recorded as such
rather than as passing mutations: re-adding `imported_from = EXCLUDED.imported_from` (unreachable once
the M3 guard exists) and removing the L11 fast path (a performance path with identical results). The
zero-row branches from L8 and L13 are defensive and are NOT covered by a test — reproducing either
needs a concurrent delete or an RLS session between the candidate SELECT and the DELETE.

**Migration.** None. `tsc --noEmit` clean, and `eslint` clean on every changed source file: the three
migration services, the wizard component and the API route. `bun run agent-docs:check` reports 74
mirrors matching.

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

**Limits.** Untagging a retained account discards its provenance: `chartOfAccountsHealthService` and
the MCP `overlaidCharts` signal stop seeing it as imported, so an overlaid chart can read as a single
one after a partial rollback. Preserving provenance needs a separate column or an audit row and is not
done here. A re-import from a second source neither re-tags nor updates the account, so its rows are
skipped and reported rather than refreshed. The rollback still leaves the opening-balance journal
posted, by the decision recorded above. Retention is decided by Postgres refusing the delete, so an
account referenced only by code rather than by id (for example the consolidation chart's
`group_accounts.account_code`) is invisible to it, exactly as it is to `accountMergeReferences`.
