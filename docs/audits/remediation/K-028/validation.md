# K-028 - PPE additions include assets acquired before the year

**Claim (BB F21):** The MIN ledger-date test is evaluated after the period WHERE clause, so an old
asset counts as both opening cost and a current-year addition.

**Corrected trigger:** Confirmed exactly. The additions CASE is not merely weakened - it is
unconditionally true for every row the query returns, so EVERY asset with any ledger period in
the year reports its full cost as an addition, not just some edge case.

**Disposition: confirmed.**

## Evidence
- `git show ebeac9ca:pages/api/accounting/assets/afs-summary.ts:55`
  `CASE WHEN MIN(apl.yyyymm) >= ${currentYearStart} THEN MAX(apl.policy_cost) ELSE 0 END`
- Same query, line 64: `AND apl.yyyymm >= ${currentYearStart}`. The aggregate is computed over
  the already-filtered set, so `MIN(apl.yyyymm) >= currentYearStart` is a tautology and the ELSE
  branch is dead.
- Lines 34-47: the prior-year snapshot query counts the same asset's `policy_cost` as opening cost.
- `src/modules/accounting/services/items/farAfsService.ts:140`
  `closingCost = openingCost + additions - disposalsCost`, so the cost is counted twice in the
  closing figure as well.
- File unchanged between 5661d6f0 and ebeac9ca.

## Reachability
`GET /api/accounting/assets/afs-summary?period=YYYYMM`, `withAuth(withErrorHandler(handler))`.
Its output is AFS note 3, Property Plant and Equipment - a figure that goes into signed annual
financial statements.

## RED test
`tests/integration/k028-ppe-additions-include-prior-year.int.test.ts` - real Postgres, real
handler. One asset bought 2024 (cost 100 000, on the books at 2025-12-31) and one bought June
2026 (cost 50 000), period 202612. 2 tests, 2 failing (`red.log`):

| figure | expected | reported |
|---|---|---|
| additions | 50 000.00 | 150 000.00 |
| closing cost | 150 000.00 | 250 000.00 |

## Proposed minimal fix (3-6 lines)
Take the first-appearance test out of the filtered aggregate. In `afs-summary.ts`, replace the
additions expression with a correlated first-period lookup, for example:

```sql
CASE WHEN (SELECT MIN(p.yyyymm) FROM asset_period_ledger p
            WHERE p.company_id = apl.company_id AND p.asset_id = apl.asset_id)
          >= ${currentYearStart}
     THEN MAX(apl.policy_cost) ELSE 0 END AS additions
```
An asset's true acquisition is `assets.purchase_date`; keying on the ledger's first period is a
proxy that also breaks if history is backfilled. Prefer `a.purchase_date` if the AFS definition
allows it, and say which one was chosen in the note.

## Second defect in the same handler (not in the claim)
Line 29 derives the prior year end as `${year - 1}${month}` - the SAME MONTH a year earlier. For
a February year-end (period 202602) the "prior year closing snapshot" is February 2025, eleven
months before the actual prior year end. It is only correct for a December year-end, and it
ignores the company's fiscal year entirely. Same for `currentYearStart = ${year}01`, which
hardcodes a January start. Needs its own K id.

## Historical-data impact
No stored rows are wrong - this is a read-side defect. Every PPE note produced from this endpoint
is wrong, for every company that owned an asset before the reporting year. Read-only impact query
(counts companies where the two populations overlap, i.e. where the note is overstated):

```sql
SELECT apl.company_id, count(DISTINCT apl.asset_id) AS assets_double_counted
FROM asset_period_ledger apl
WHERE apl.yyyymm >= '202601'
  AND EXISTS (SELECT 1 FROM asset_period_ledger p
               WHERE p.asset_id = apl.asset_id AND p.yyyymm < '202601')
GROUP BY 1 ORDER BY 2 DESC;
```
NOT run against production. Any AFS already issued off this endpoint needs its note 3 restated.

## Risks
Fixing additions changes published note figures. Check whether any signed AFS or exported pack
carries the overstated closing cost before shipping, and whether the AFS pre-export checks
(`tests/integration/afs-pre-export-checks.int.test.ts`) assert the current wrong totals.
