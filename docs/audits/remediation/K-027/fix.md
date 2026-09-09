# K-027 fix — depreciation carries forward accumulated tax depreciation

**Trigger.** Every depreciation run, from the second period onwards.
`loadDepreciationAssets` (`depreciationRunPlan.ts:108`) reads the tax opening
balance from `assets.tax_accumulated_depreciation`, and no code path wrote it.
`postDualDepreciationToLedger` wrote back only `accumulated_depreciation` and
`current_book_value`.

**Before.** Every period opened at the seeded tax accumulated depreciation
(normally 0). `asset_period_ledger.tax_closing_acc_dep` never accumulated,
`tax_carrying_amount` stayed at cost minus one period, and `deferred_tax` was
computed off that wrong carrying amount.

**After.** Inside the existing per-asset savepoint, immediately after the ledger
upsert, the run sets `assets.tax_accumulated_depreciation` and
`tax_book_value` to the closing figures the ledger row just recorded. SET, not
increment, so it mirrors the ledger row rather than drifting from it. Scoped by
`id` AND `company_id`. Ledger row, asset write-back and GL entry still commit or
roll back together.

**Files.** `src/modules/accounting/services/gl/assetDepreciationPosting.ts`
(+13 lines, 263 total).

**Tests.** `tests/integration/k027-tax-depreciation-carry-forward.int.test.ts` —
6 tests, all passing against real Postgres (`green.log`). The validator's 3
plus three adjacent cases: re-posting a period does not double the accumulation
(`already_posted` skips it), a dry run (plan without execute) writes nothing,
and a second company's asset is untouched. Mutation check: reverting the
production change turns 4 of the 6 red (`green.log`).

**Migration / rollback.** None. Rollback is reverting the commit; the asset
columns then simply stop being maintained again.

**Historical-data impact.** Wide, and NOT corrected here. For every company that
has run depreciation more than once: `assets.tax_accumulated_depreciation` and
`tax_book_value` are stale; every `asset_period_ledger` row after the first
understates `tax_closing_acc_dep` and overstates `tax_carrying_amount`, so
`deferred_tax` is wrong on each; `pages/api/accounting/assets/[assetId]/dispose.ts:46`
read a nil tax accumulated depreciation for every disposal recapture to date;
the FAR report (`far-report.ts:101`) prints the ledger, so its tax column is
wrong too. Read-only impact query (syntax-checked on the fixture, NOT run
against production):

```sql
SELECT a.company_id, count(*) AS assets,
       count(*) FILTER (WHERE COALESCE(a.tax_accumulated_depreciation,0) = 0) AS tax_acc_zero,
       max(l.periods) AS periods_run
FROM assets a
JOIN (SELECT asset_id, company_id, count(*) AS periods
        FROM asset_period_ledger GROUP BY 1,2) l
  ON l.asset_id = a.id AND l.company_id = a.company_id
WHERE l.periods > 1
GROUP BY 1 ORDER BY assets DESC;
```

**What a backfill would need (not written — deliberately out of scope).** Not a
single UPDATE. Each period's tax depreciation depends on the previous closing
balance and is capped by the remaining tax base, so the repair must walk
`asset_period_ledger` per asset in `yyyymm` order, re-running
`calculateTaxDepreciation` with the recomputed opening for each row, rewriting
`tax_opening_acc_dep` / `tax_current_dep` / `tax_closing_acc_dep` /
`tax_carrying_amount` / `deferred_tax`, and only then setting the two asset
columns from the last row. It must be company-scoped per statement and idempotent.
Deferred-tax movements already posted to the GL, and disposal recapture already
computed from the nil balance, need separate review before any figures change.

**Limits.** Only the run path is corrected. Assets seeded with a non-zero
`tax_opening_acc_dep` at import still ignore that column — the service reads
`tax_accumulated_depreciation` only, which is unchanged behaviour. No existing
row is repaired by this commit.
