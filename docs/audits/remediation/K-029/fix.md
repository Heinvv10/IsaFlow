# K-029 fix — posted depreciation now follows the asset's configured method

**Trigger.** `loadDepreciationAssets` never SELECTed `assets.depreciation_method`,
and `calculatePolicyDepreciation` had no method parameter at all, so the engine
was unconditionally straight line. Every asset saved as `reducing_balance` or
`sum_of_years` was charged straight line by the monthly run, the dry-run preview
and the MCP tool alike.

**Before / after.** For a R100 000 asset, 5-year life, no residual, in year 3
of its life, `reducing_balance`: the run posted R1 666.67/month; it now posts
R1 200.00. `straight_line` assets are unchanged.

- reducing balance = 2 / life on the YEAR-OPENING carrying amount, switching to
  straight line over the remaining life once that is larger, so the schedule
  ends exactly on the residual at the end of the life
- sum of years = depreciable amount x remaining years / n(n+1)/2
- the final month of the life trues the schedule up, so the pro-rated first
  month is recovered under every method
- residual cap, first-month pro-rate and post-disposal zero are unchanged and
  apply to all three methods.

**Files.** New `depreciationMethods.ts` — the method type,
`toDepreciationMethod`, `annualPolicyCharge`, and the policy calculator moved
whole out of `farDepreciationService.ts`, which the addition would otherwise
have pushed past the 300-line cap (186 / 214 lines now). Every policy symbol is
re-exported from `farDepreciationService.ts`, so no existing importer changes.
`depreciationRunPlan.ts` SELECTs the column; `assetDepreciationPosting.ts`,
`depreciationRunService.ts` and `depreciationRunPreview.ts` thread the field.

`asset_categories.depreciation_method` (migration 360) says `diminishing_balance`
where `assets` says `reducing_balance`; `toDepreciationMethod` folds the two and
falls back to straight line on anything unrecognised. Both columns are NOT NULL,
so no category COALESCE is needed in the loader.

**Tests.** `tests/integration/k-029-depreciation-method.int.test.ts` — 3 passed
against the real fixture DB: loader exposes the method; tenant scoping; a full
`planDepreciationRun` + `executeDepreciationRun` posting three assets, asserting
each journal balances, equals its method's charge on both legs, and agrees with
`asset_period_ledger.policy_current_dep`.
`tests/unit/services/assets/farDepreciationService.test.ts` — 37 passed (11 new:
defaults, both new methods, declining charge, residual cap, first-month pro-rate,
end of life, post-disposal, vocabulary folding).
Regression: the existing `tests/unit/mcp/runDepreciationDb.test.ts` — 15 passed
against isaflow_dev (its own guard refuses the schema fixture DB).
Mutation-proof: dropping the SELECT column, and disabling the reducing-balance
and the sum-of-years branch, each turn the tests RED (see green.log).

**Migration / rollback.** None. Revert the commit to restore prior behaviour.

**Historical data.** Every posted `DEP-*` journal for a non-straight-line asset
carries the wrong charge, and `assets.accumulated_depreciation` plus
`asset_period_ledger` compound it. This fix corrects future periods only;
restating prior periods is an accounting decision. Read-only scope query:

```sql
SELECT a.company_id, a.depreciation_method, COUNT(*) AS assets,
       SUM(a.accumulated_depreciation) AS acc_dep
FROM assets a WHERE a.depreciation_method <> 'straight_line'
GROUP BY 1,2 ORDER BY 3 DESC;
```

**Limits.** Reducing balance uses the 2/life double-declining rate; a per-asset
rate column does not exist. The method does NOT inherit from `asset_categories`
— `assets.depreciation_method` is NOT NULL DEFAULT 'straight_line', so an
inherited value cannot be told apart from a deliberate one; making it inherit
needs a nullable column and is a schema decision. Not run against production
data. See fix-round2.md for the eight review findings and what each changed.
