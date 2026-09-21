# K-027 - Depreciation does not carry forward accumulated tax depreciation

**Claim (BB F20):** Posting updates only policy accumulation on assets, so each run recomputes
tax depreciation from a stale opening balance.

**Corrected trigger:** Confirmed as stated, with the loop closed: the run's tax opening balance
is read from `assets.tax_accumulated_depreciation`, which no code path ever writes. The
`asset_period_ledger` row does hold the correct closing balance, but nothing reads it back.

**Disposition: confirmed.**

## Evidence
- `git show ebeac9ca:src/modules/accounting/services/gl/assetDepreciationPosting.ts:137-143` -
  the only write-back after posting sets `accumulated_depreciation` and `current_book_value`.
  `tax_accumulated_depreciation` and `tax_book_value` do not appear in the file at all.
- `git show ebeac9ca:src/modules/accounting/services/items/depreciationRunPlan.ts:108` -
  `COALESCE(a.tax_accumulated_depreciation, 0) AS tax_acc_dep` in `loadDepreciationAssets`.
- `git show ebeac9ca:src/modules/accounting/services/items/depreciationRunService.ts:159` -
  `taxOpeningAccDep: Number(a.tax_acc_dep)` handed to `postDualDepreciationToLedger`.
- `assetDepreciationPosting.ts:186-193` feeds that straight into `calculateTaxDepreciation`,
  whose result becomes `tax_opening_acc_dep` / `tax_closing_acc_dep` /
  `tax_carrying_amount` / `deferred_tax` on the ledger row (lines 209-233).
- File unchanged between 5661d6f0 and ebeac9ca.

## Reachability
Every depreciation run. `loadDepreciationAssets` then `planDepreciationRun` then
`executeDepreciationRun` is the single execution path.

## RED test
`tests/integration/k027-tax-depreciation-carry-forward.int.test.ts` - real Postgres, real run
service, two consecutive periods on one R120 000 asset with a 5-year tax life
(R2 000 tax depreciation a month). 3 tests, 2 failing (`red.log`):
- `assets.tax_accumulated_depreciation` is 0.00 after January (expected 2 000.00) while
  `accumulated_depreciation` IS written;
- February's ledger row opens at 0.00 (expected 2 000.00) and closes at 2 000.00
  (expected 4 000.00).
The January-only assertion passes, which is what pins the defect to carry-forward rather than
to the tax calculation itself.

## Proposed minimal fix (3-6 lines)
In `assetDepreciationPosting.ts`, `postDualDepreciationToLedger` already has `tax` in scope and
already owns the per-asset savepoint. Inside that savepoint, after the ledger upsert, add:

```sql
UPDATE assets SET tax_accumulated_depreciation = ${tax.closingTaxAccDep},
                  tax_book_value = ${tax.taxCarryingAmount}, updated_at = NOW()
WHERE id = ${assetId} AND company_id = ${companyId}::UUID
```
Set (not increment), so a re-run of the same period is idempotent and matches the ledger row the
upsert just wrote.

## Historical-data impact
Wide. For every company that has run depreciation more than once:
- `assets.tax_accumulated_depreciation` is 0 (or whatever was seeded at import) on every asset;
- every `asset_period_ledger` row after the first understates `tax_closing_acc_dep` and
  overstates `tax_carrying_amount`, so `deferred_tax` on each row is wrong;
- `pages/api/accounting/assets/[assetId]/dispose.ts:46` reads
  `COALESCE(a.tax_accumulated_depreciation, 0)`, so every disposal recapture computed to date
  used a nil tax accumulated depreciation;
- the FAR report reads the ledger (`far-report.ts:101`), so the printed tax column is wrong too.

Read-only impact query:

```sql
SELECT a.company_id, count(*) AS assets,
       count(*) FILTER (WHERE COALESCE(a.tax_accumulated_depreciation,0) = 0) AS tax_acc_zero,
       max(l.periods) AS periods_run
FROM assets a
LEFT JOIN (SELECT asset_id, count(*) AS periods FROM asset_period_ledger GROUP BY 1) l
       ON l.asset_id = a.id
WHERE l.periods > 1
GROUP BY 1 ORDER BY assets DESC;
```
NOT run against production.

## Risks
Correcting history is not a single UPDATE: the ledger rows must be recomputed period by period
in order, because each period's tax depreciation depends on the previous closing balance and is
capped by the remaining tax base. A backfill that only sets the asset column leaves the ledger
and the FAR report disagreeing. Deferred tax movements already posted to the GL would also need
review before any figures change.
