# K-029 — Posted depreciation ignores the configured policy method

**Claim (BB F22):** the depreciation run loader omits the asset's method, so
reducing-balance and sum-of-years assets are depreciated straight-line.

**Corrected trigger:** the omission is real but it is not confined to the loader.
`calculatePolicyDepreciation` has NO method parameter at all — the engine is
unconditionally straight-line — so adding the column to the SELECT alone changes
nothing. Any asset whose `depreciation_method` is not `straight_line` is charged
straight-line by the monthly run, the preview, and the MCP tool alike.

**Disposition: confirmed.**

## Evidence (all `git show ebeac9ca:<path>`)
- `src/modules/accounting/services/items/depreciationRunPlan.ts:100-125` —
  `loadDepreciationAssets` SELECTs cost, life, residual, tax life; no
  `depreciation_method`, and no `asset_categories.depreciation_method` either.
- `src/modules/accounting/services/items/farDepreciationService.ts:9-22,110-180` —
  `PolicyDepreciationInput` has no method field; the body computes
  `annualDep = depreciableAmount / usefulLifeYears` only.
- `src/modules/accounting/services/gl/assetDepreciationPosting.ts:176` and
  `src/modules/accounting/services/items/depreciationRunPreview.ts:78` — both
  call that calculator, so post and preview agree on the wrong number.
- Reachability: the method is user-selectable at
  `pages/accounting/assets/new.tsx:22-26` (Straight-Line / Reducing Balance /
  Sum-of-Years), validated in `assetService.ts:167`, persisted by
  `pages/api/accounting/assets.ts:104-112`. Schema `244_fixed_assets.sql:51`
  CHECKs the three values; the fixture DB confirms the column and default.
- File unchanged between 5661d6f0 and ebeac9ca (`git log --oneline 5661d6f0..ebeac9ca`).

## RED test
`tests/integration/k-029-depreciation-method.int.test.ts` — 1 failed / 1 total.
Seeds a real asset with `depreciation_method='reducing_balance'`, R100 000 cost,
5-year life, R20 000 opening accumulated depreciation, then calls the real
loader. Fails at the claimed reason: the loaded row has no `depreciation_method`
(received `undefined`). Second assertion, unreached, pins the money: reducing
balance is R2 666.67/month against the R1 666.67 straight-line the engine
returns. Output: `docs/audits/remediation/K-029/red.log`.

## Proposed minimal fix
1. Add `COALESCE(a.depreciation_method, c.depreciation_method, 'straight_line') AS depreciation_method`
   to `loadDepreciationAssets`.
2. Add `method: 'straight_line' | 'reducing_balance' | 'sum_of_years'` to
   `PolicyDepreciationInput` and branch the annual charge in
   `calculatePolicyDepreciation` (reducing balance: `(cost - openingAccDep) * 2/life`;
   sum-of-years: `depreciableAmount * remainingYears / (n(n+1)/2)`), keeping the
   existing residual, first-month pro-rate and remaining-amount cap.
3. Thread the field through `assetDepreciationPosting.ts:176` and
   `depreciationRunPreview.ts:78`.

## Historical-data impact
Every posted `DEP-*` journal for a non-straight-line asset understates or
overstates the charge, and `assets.accumulated_depreciation` plus
`asset_period_ledger` carry the error forward compounding. Read-only scope query:
```sql
SELECT a.company_id, a.depreciation_method, COUNT(*) AS assets,
       SUM(a.accumulated_depreciation) AS acc_dep
FROM assets a WHERE a.depreciation_method <> 'straight_line'
GROUP BY 1,2 ORDER BY 3 DESC;
```
Note `asset_categories.depreciation_method` (migration 360) only allows
`straight_line`/`diminishing_balance`, so category and asset vocabularies differ —
the fix must not assume they are the same enum.

## Risks
Correcting the engine changes future charges for existing assets; restating prior
periods is a separate accounting decision, not part of the code fix.
