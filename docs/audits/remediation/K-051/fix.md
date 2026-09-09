# K-051 fix — a merge may not turn its target into a header account

**Trigger.** `mergeAccounts(company, source, target)` where the target is an asset, liability or
equity account at `level < 3` and the source has direct children (they are reparented onto the
target), or where the target is already such an account with children and the source brings
something to move.

**Before.** `assertMergeable` never read `level`. The merge reparented the children, the target
acquired children, and `balanceSheetService.ts:120-128` / `trendRowsService.ts:174-175` — which
select an account only when `level >= 3 OR it has no children` — stopped returning it. Total assets
in the fixture went from R1,500 to R0 while the trial balance was unchanged.

**After.** `assertTargetStaysOnTheReports` throws `AccountMergeError('target_becomes_header')`
before anything is written, and runs AFTER the cycle check so a descendant target still reports
`target_is_descendant_of_source`. Three cases stay admitted, each with a test: level 3+ targets
(the reports select them regardless of children); revenue and expense targets (the income statement
applies no level filter, so nothing disappears); and a source with neither children nor journal
lines, which contributes nothing to move — the same refinement `accountParentRules` makes.

**Files.**
- `src/modules/accounting/services/gl/isReportVisibleLeaf.ts` (new; shared with K-052; owns
  `BALANCE_SHEET_LEAF_LEVEL`, moved here out of `accountParentRules.ts`, and
  `LEAF_RULE_ACCOUNT_TYPES`)
- `src/modules/accounting/services/gl/accountMergeGuards.ts` (guard + `target_becomes_header` code)
- `src/modules/accounting/services/gl/accountMergeService.ts` (comment only: why the existing row
  lock already closes the concurrent-chart-edit window)
- `src/modules/accounting/services/gl/accountParentRules.ts` (the THIRD guard: same type
  scoping, and its refusal no longer names the balance sheet for an expense parent)

**Tests.** `tests/integration/k051-account-merge-into-header-hides-balance.int.test.ts` — 11 tests,
real disposable Postgres. The refusal with the balance sheet unchanged and the child unmoved; an
already-header target refused when the source carries lines; the same target admitted from an empty
source; a R300 balance merged into a leaf target and asserted ON the target's own balance-sheet
line; a level-3 target that HAS children admitted; a level-2 expense header admitted; a descendant
target reported as a cycle; another tenant's child ignored; and a two-connection proof that
`FOR UPDATE` on the target blocks both a child INSERT and a reparent UPDATE with `55P03`. Two
more close mutations the earlier round left alive: a Sage level-1 CHILDLESS target taking a
source that carries R120, and `assertParentUsable` admitting a posted level-2 expense parent
while still refusing the asset one.

**Migration.** None.

**Concurrency — THE MERGE PATH ONLY.** The blind review asked for a post-write re-read of the
guard. In `mergeAccounts` it is unreachable: `gl_accounts_parent_account_id_fkey` references
`gl_accounts(id)`, so a concurrent `createAccount` or `reclassifyAccount` naming the target as
parent takes FOR KEY SHARE on the target row, which conflicts with the merge's FOR UPDATE. It
waits, lands after the merge, and `assertParentUsable` then refuses it because the target carries
posted lines. Proved, not assumed. This does NOT carry to the reclassification, which locks the
journal lines and not the account — see K-052's fix.md; that path takes its own FOR UPDATE.

**Historical-data impact.** Merges already performed into a level <= 2 asset/liability/equity
target have removed that account's balance from the balance sheet and the trend report. No debit or
credit is wrong, so the remedy is a chart edit (give the target a leaf child, or raise its level),
not a ledger correction. Read-only census, not run against production:

```sql
SELECT m.id, m.company_id, m.target_account_id, ga.account_code, ga.level, m.created_at
FROM gl_account_merges m
JOIN gl_accounts ga ON ga.id = m.target_account_id AND ga.company_id = m.company_id
WHERE ga.level < 3
  AND ga.account_type IN ('asset','liability','equity')
  AND EXISTS (SELECT 1 FROM gl_accounts c
               WHERE c.parent_account_id = ga.id AND c.company_id = ga.company_id);
```

**Limits.** The guard mirrors the reports' predicate as it stands today; a report that changes its
own selection rule must change this helper with it. Accounts already sitting under a header are not
repaired by this change.
