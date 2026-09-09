# K-027 fix — depreciation carries forward accumulated tax depreciation

Two commits: `71c70ece` (the carry-forward) and this one, which corrects the
four defects a blind review found in it. Read them together.

**Trigger.** Every depreciation run, from the second period onwards.
`loadDepreciationAssets` (`depreciationRunPlan.ts`) reads the tax opening
balance from `assets.tax_accumulated_depreciation`, and no code path wrote it.
`postDualDepreciationToLedger` wrote back only `accumulated_depreciation` and
`current_book_value`.

**Before.** Every period opened at the seeded tax accumulated depreciation
(normally 0). `asset_period_ledger.tax_closing_acc_dep` never accumulated,
`tax_carrying_amount` stayed at cost minus one period, and `deferred_tax` was
computed off that wrong carrying amount.

**After.** Inside the existing per-asset savepoint, after the ledger upsert, the
run sets `assets.tax_accumulated_depreciation` and `tax_book_value` from the
asset's LATEST subledger row (`ORDER BY yyyymm DESC LIMIT 1`), in SQL, scoped by
`company_id`. Reading the row back rather than SETting the JavaScript figures is
what makes it correct under two conditions the first commit got wrong:
`period_date` is caller-supplied, so back-posting January after February must
not regress the column to January's closing; and the figure was computed from a
snapshot taken before the transaction, so two concurrent runs for different
periods would otherwise both write an absolute value and the later commit would
drop the earlier one.

The plan additionally skips an asset that already holds an
`asset_period_ledger` row for the period, under its own reason
`already_in_subledger`. The pre-existing `already_posted` guard keys on the
JOURNAL, and no journal is written when the policy charge is zero — which is
ordinary, since the policy base is `cost * (1 - residualPct)` against a tax base
of full cost, so any asset with a residual or a longer tax life ends its life at
policy 0 with tax still running. Without the second key such an asset stayed
postable for ever and every re-run doubled the tax column and rewrote the
subledger row to two months of wear in one calendar month.

**Files.**
- `src/modules/accounting/services/gl/assetDepreciationPosting.ts` (280 lines)
- `src/modules/accounting/services/items/depreciationRunPlan.ts` (300 lines)
- `src/lib/mcp/tools/writeDepreciation.ts` — the `run_depreciation` description
  claimed re-runs were safe "by entry number", which was the false half.

**Tests.** 10 passing against real Postgres, in two files.
- `tests/integration/k027-tax-depreciation-carry-forward.int.test.ts` (6): two
  consecutive periods open and close correctly; re-posting a period with a
  journal does not double; a dry run writes nothing; a second company is
  untouched; journal counts asserted at each step.
- `tests/integration/k027-tax-depreciation-idempotency.int.test.ts` (4): an
  asset at policy 0 with tax still running posts tax and NO journal; re-running
  that period changes nothing (skip reason `already_in_subledger`, subledger row
  still one month); February-then-January leaves the asset on February; March
  then opens on February's closing.

Mutation checks, both recorded in `green.log`: reverting the first commit's
production change turns 4 of the first file's 6 red; reverting to `71c70ece`
turns 3 of the second file's 4 red, at exactly the figures the review measured
(4 000 where 2 000 is correct).

**Migration / rollback.** None. Rollback is reverting both commits.

**Historical-data impact.** Wide, and NOT corrected here. For every company that
has run depreciation more than once: `assets.tax_accumulated_depreciation` and
`tax_book_value` are stale; every `asset_period_ledger` row after the first
understates `tax_closing_acc_dep` and overstates `tax_carrying_amount`, so
`deferred_tax` is wrong on each; `pages/api/accounting/assets/[assetId]/dispose.ts`
read a nil tax accumulated depreciation for every disposal recapture to date;
the FAR report (`far-report.ts`) prints the ledger, so its tax column is wrong.

The detection query must compare each period's opening against the previous
period's closing, NOT look for a zero asset column. A zero column stops being
the symptom the moment this fix runs once: the first post-fix run writes a
plausible non-zero figure that is still wrong by every earlier period. This
query stays valid before and after deployment (syntax-checked on the disposable
fixture; NOT run against production):

```sql
WITH ordered AS (
  SELECT company_id, asset_id, yyyymm, tax_opening_acc_dep,
         LAG(tax_closing_acc_dep) OVER (
           PARTITION BY company_id, asset_id ORDER BY yyyymm) AS prior_closing
  FROM asset_period_ledger
)
SELECT company_id,
       count(DISTINCT asset_id) AS assets_with_broken_carry_forward,
       count(*)                 AS broken_period_rows,
       min(yyyymm)              AS first_broken_period,
       max(abs(tax_opening_acc_dep - prior_closing)) AS worst_gap
FROM ordered
WHERE prior_closing IS NOT NULL
  AND abs(tax_opening_acc_dep - prior_closing) > 0.005
GROUP BY 1 ORDER BY 2 DESC;
```

And, for the asset columns against the latest subledger row:

```sql
SELECT a.company_id, count(*) AS assets_disagreeing_with_subledger
FROM assets a
JOIN LATERAL (
  SELECT tax_closing_acc_dep FROM asset_period_ledger l
  WHERE l.company_id = a.company_id AND l.asset_id = a.id
  ORDER BY l.yyyymm DESC LIMIT 1
) l ON true
WHERE abs(COALESCE(a.tax_accumulated_depreciation, 0) - l.tax_closing_acc_dep) > 0.005
GROUP BY 1 ORDER BY 2 DESC;
```

**What a backfill would need (not written — deliberately out of scope).** Not a
single UPDATE. Each period's tax depreciation depends on the previous closing
balance and is capped by the remaining tax base, so the repair must walk
`asset_period_ledger` per asset in `yyyymm` order, re-running
`calculateTaxDepreciation` with the recomputed opening for each row, rewriting
`tax_opening_acc_dep` / `tax_current_dep` / `tax_closing_acc_dep` /
`tax_carrying_amount` / `deferred_tax`, and only then setting the two asset
columns from the last row. Company-scoped per statement, and idempotent.
Deferred-tax movements already posted to the GL, and disposal recapture already
computed from the nil balance, need separate review before any figures move.

**Limits.**
- No existing row is repaired by either commit.
- Back-posting an OLD period still writes a subledger row whose
  `tax_opening_acc_dep` came from the asset column, i.e. from the newest period
  rather than from the period before it. The asset column and every later run
  are now correct, but that one retro row remains internally inconsistent. This
  is pre-existing, not introduced here — the opening has always come from the
  asset column — and fixing it means sourcing the opening from the preceding
  subledger row, which is a change to the calculator's inputs and out of scope
  for this ticket. The `worst_gap` query above detects it.
- Assets seeded with a non-zero `tax_opening_acc_dep` at import still ignore
  that column; the service reads `tax_accumulated_depreciation` only. Unchanged
  behaviour.
- Nothing serialises two concurrent `run_depreciation` calls. The write-back is
  now atomic in SQL, so neither call can lose the other's update, but the run as
  a whole takes no advisory lock.
