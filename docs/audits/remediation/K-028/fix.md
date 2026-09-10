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

Review follow-ups, same file:
- The `period` guard was `/^\d{6}$/`, which accepts `202600` and `202613`. Those reached the date
  arithmetic and became a 500 on caller input. Now `/^\d{4}(0[1-9]|1[0-2])$/`, a 400.
- The prior-year snapshot took each asset's last row at or before the prior year end. For an asset
  disposed BEFORE the year opened that is the disposal row, which carries full `policy_cost`: it
  sat in opening cost forever, and `disposalsCost` never removed it because the disposal fell
  outside the movement window. The snapshot now drops rows with `disposal_proceeds IS NOT NULL`.
- The window arithmetic moved into `fiscalWindowForPeriod` in `afs/afsFiscalPeriod.ts`, the module
  that already owns the AFS fiscal calendar, rather than being hand-rolled here for a third time.

## Tests
- `tests/integration/k028-ppe-additions-include-prior-year.int.test.ts` — validator RED, 2 tests.
- `tests/integration/k028-afs-summary-fiscal-year.int.test.ts` — 4 tests: February year end
  snapshots at February and charges 12 months; an interim period opens at the prior financial
  year end; a neighbouring tenant's figures are unchanged; a NULL basis is refused.
- `tests/integration/k028-afs-summary-boundaries.int.test.ts` — 9 tests: five invalid periods are
  400 not 500, `202601`/`202612` still 200, an asset disposed before the year is out of opening
  cost, a disposal inside the year is still reported, a ledger-less asset is omitted.
- `tests/unit/services/afs/afsFiscalPeriod.test.ts` — 7 added for `fiscalWindowForPeriod`,
  including the December wrap for all twelve start months and both refusals.
- 15/15 real-DB, full unit suite green. Mutation proof of every change in `green.log`.

## Historical impact
**No statement needs restating, because nothing consumes this endpoint.** A repo-wide grep for
`afs-summary` returns the route and its own tests and nothing else — no page, no service, no
export. The note 3 that is generated, snapshotted and filed is
`generateNote3PropertyPlantEquipment` (`afs/noteGenerators/notes1to5.ts`), a separate
implementation reading `assets.purchase_price` / `purchase_date` against `getFiscalRange`, which
never touches `asset_period_ledger`. The endpoint's header comment claimed otherwise and has been
corrected. **Raised separately:** the two PPE notes disagree and neither reconciles against the
other; the filed one sums `purchase_price` over non-disposed assets and keys additions off
`purchase_date`. That is untouched by this fix and needs its own K id.

Anyone who called the endpoint directly got an overstated figure. Read-only impact query, which
counts the exposure if a consumer is ever added (NOT run against production):

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
- Both queries read only `asset_period_ledger`, so an asset that exists in `assets` but has never
  been through a depreciation run — bought in the last month, or a run not yet executed — appears
  in neither opening cost nor additions. Pinned by a test rather than fixed: surfacing it would
  change the response contract, and the endpoint has no consumer to serve. It is the main reason
  this endpoint and the filed note 3 can disagree.
- Rollback is a revert of `afs-summary.ts`; `fiscalWindowForPeriod` is a new export with no other
  caller and can stay or go with it.
