# K-051 fix — a merge may not turn its target into a header account

**Trigger.** `mergeAccounts(company, source, target)` where `target.level < 3` and the source has
direct children (they are reparented onto the target), or where the target is already a level 1/2
account with children.

**Before.** `assertMergeable` never read `level`. The merge reparented the children, the target
acquired children, and `balanceSheetService.ts:120-128` / `trendRowsService.ts:174-175` — which
select an account only when `level >= 3 OR it has no children` — stopped returning it. Total assets
in the fixture went from R1,500 to R0 while the trial balance was unchanged.

**After.** `assertMergeable` throws `AccountMergeError('target_becomes_header')` before anything is
written. Level 3+ targets and childless level 1/2 targets (Sage-imported charts) still merge.

**Files.**
- `src/modules/accounting/services/gl/isReportVisibleLeaf.ts` (new; shared with K-052)
- `src/modules/accounting/services/gl/accountMergeGuards.ts` (guard + `target_becomes_header` code)

**Tests.** `tests/integration/k051-account-merge-into-header-hides-balance.int.test.ts` — 4 tests,
real disposable Postgres: the refusal with the balance sheet unchanged and the child unmoved; a
level-2 target that is already a header refused from a childless source; a leaf target still merged
with total assets unchanged; another tenant's child under a level-1 target ignored.

**Migration.** None.

**Historical-data impact.** Merges already performed into a level <= 2 target have removed that
account's balance from the balance sheet and the trend report. No debit or credit is wrong, so the
remedy is a chart edit (give the target a leaf child, or raise its level), not a ledger correction.
Read-only census, not run against production:

```sql
SELECT m.id, m.company_id, m.target_account_id, ga.account_code, ga.level, m.created_at
FROM gl_account_merges m
JOIN gl_accounts ga ON ga.id = m.target_account_id AND ga.company_id = m.company_id
WHERE ga.level < 3
  AND EXISTS (SELECT 1 FROM gl_accounts c
               WHERE c.parent_account_id = ga.id AND c.company_id = ga.company_id);
```

**Limits.** The guard mirrors the reports' predicate as it stands today; a report that changes its
own selection rule must change this helper with it. Accounts already sitting under a header are not
repaired by this change.
