# K-028 fix — PPE additions counted assets acquired before the year (+ R-007)

**Read-side only. No stored row is wrong; no data migration.**

## Trigger
`GET /api/accounting/assets/afs-summary?period=YYYYMM`, feeding AFS note 3.
1. **K-028** — additions were `CASE WHEN MIN(apl.yyyymm) >= currentYearStart ...`, an
   aggregate over rows the WHERE clause had already restricted to `yyyymm >= currentYearStart`.
   Always true, ELSE branch dead. Every asset with a ledger row in the year reported its full
   cost as an addition, while the prior-year snapshot also carried it as opening cost.
   `closingCost = openingCost + additions - disposals`, so cost was double counted.
2. **R-007** — `currentYearStart = ${year}01` and `priorYYYYMM = ${year-1}${month}` hardcode a
   December year end. For a February year end (`financial_year_start = 3`) the movement window
   and the opening snapshot both land in the wrong twelve months.

## Before / after (validator fixture, period 202612)
| figure | before | after |
|---|---|---|
| additions | 150 000 | 50 000 |
| closing cost | 250 000 | 150 000 |

## Change
`pages/api/accounting/assets/afs-summary.ts` only (+21 / -8).
- First appearance now comes from a correlated `MIN(p.yyyymm)` over the asset's **whole** ledger
  history, scoped `p.company_id = ${companyId}::UUID`. Kept on the ledger rather than
  `assets.purchase_date`: purchase date is the tax/acquisition date and is not what the ledger
  is built from, so the note would stop footing to the ledger it reports.
- Boundaries derive from `getFiscalYearStartMonth` + `fiscalYearStart` (gl/fiscalYearBasis).
  Called with **no fallback**: an AFS note is signed and filed, so a tenant with no
  `financial_year_start` gets a 500 rather than a silently March-shaped statement.
- Response contract unchanged (`{ period, groups }`, same group fields).

## Tests
- `tests/integration/k028-ppe-additions-include-prior-year.int.test.ts` — validator RED, 2 tests.
- `tests/integration/k028-afs-summary-fiscal-year.int.test.ts` — 4 tests: February year end
  snapshots at February and charges 12 months; an interim period opens at the prior financial
  year end; a neighbouring tenant's figures are unchanged; a NULL basis is refused.
- 6/6 real-DB. Full unit suite 9391 passed. Mutation proof of both changes in `green.log`.

## Historical impact
Every PPE note this endpoint produced is overstated for any company that owned an asset before
the reporting year, and mis-scoped for any non-December year end. Any AFS already issued off it
needs note 3 restated. Read-only impact query (NOT run against production):

```sql
SELECT apl.company_id,
       count(DISTINCT apl.asset_id) AS assets_double_counted
FROM asset_period_ledger apl
WHERE apl.yyyymm >= '202601'
  AND EXISTS (SELECT 1 FROM asset_period_ledger p
               WHERE p.company_id = apl.company_id
                 AND p.asset_id = apl.asset_id
                 AND p.yyyymm < '202601')
GROUP BY 1 ORDER BY 2 DESC;
```

## Limits
- The additions test still keys on the ledger, so backfilling history for an old asset moves it
  out of additions. That is the correct behaviour for a note built from the ledger, but it means
  the figure follows ledger construction, not the invoice.
- Rollback is a straight revert of the one file; nothing else was touched.
