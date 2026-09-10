/**
 * The tax side of an asset's accumulated depreciation, read and written under a
 * row lock.
 *
 * `assets.tax_accumulated_depreciation` is a CACHE of the fixed asset
 * subledger, not the source of truth. Two things follow, and both were defects
 * before this module existed.
 *
 * A period's opening balance must come from the SUBLEDGER, not from the asset
 * column. `period_date` is caller-supplied on both the REST route and the MCP
 * tool, so a run may post an OLDER period than the one the column reflects.
 * Reading the column there opens the back-posted period on a newer balance, and
 * its charge never reaches the accumulation: posting February, then January,
 * then March left the asset at 4 000 while the subledger had charged 6 000.
 *
 * And the read must be serialised. Nothing else orders two concurrent
 * `run_depreciation` calls — no advisory lock anywhere in the run — so both
 * would read the same opening and the later commit would silently drop the
 * earlier period's charge. Re-reading inside the transaction does NOT fix that:
 * the subquery runs under the reader's own snapshot and cannot see a row the
 * other transaction has not yet committed. `FOR UPDATE` on the asset row is
 * what makes the read-then-write a critical section, in the way the policy
 * increment in `assetDepreciationPosting.ts` gets for free by being a
 * read-modify-write on the locked row itself.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

/** Currency, to the cent. Float sums of numerics drift otherwise. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface AssetTaxBase {
  /** Accumulated tax depreciation as at the START of the period being posted. */
  openingForPeriod: number;
  /**
   * Accumulated tax depreciation from every subledger period OTHER than the one
   * being posted. Adding this period's charge to it gives the new total, which
   * is what makes a same-period re-post idempotent rather than cumulative.
   */
  accumulatedElsewhere: number;
}

/**
 * Locks the asset row, then derives its tax accumulation from the subledger.
 *
 * `base` is the opening that pre-dates the subledger — an imported balance, for
 * an asset that carried accumulated tax depreciation before it was captured.
 * It is preserved as the EARLIEST subledger row's own opening, so it survives
 * every later run. With no rows yet it comes from the asset column, which is
 * the only place a first run can find it.
 *
 * Must be called inside the request transaction. Outside one, `FOR UPDATE` is
 * released the instant the SELECT returns and locks nothing.
 */
export async function lockAssetTaxBase(
  companyId: string,
  assetId: string,
  yyyymm: string,
): Promise<AssetTaxBase> {
  // Re-issued per call, never memoised: `SET LOCAL` is subtransaction-aware, so
  // a `ROLLBACK TO SAVEPOINT` restores the previous value — which is 0, meaning
  // no timeout at all. The run wraps every asset in a savepoint.
  await sql`SET LOCAL lock_timeout = '5s'`;
  await sql`
    SELECT id FROM assets
    WHERE id = ${assetId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `;

  const rows = (await sql`
    SELECT
      (SELECT tax_opening_acc_dep FROM asset_period_ledger
        WHERE company_id = ${companyId}::UUID AND asset_id = ${assetId}::UUID
        ORDER BY yyyymm ASC LIMIT 1)                                    AS base,
      COALESCE(SUM(tax_current_dep) FILTER (WHERE yyyymm < ${yyyymm}), 0)  AS before_period,
      COALESCE(SUM(tax_current_dep) FILTER (WHERE yyyymm <> ${yyyymm}), 0) AS other_periods,
      (SELECT COALESCE(tax_accumulated_depreciation, 0) FROM assets
        WHERE id = ${assetId}::UUID AND company_id = ${companyId}::UUID) AS asset_column
    FROM asset_period_ledger
    WHERE company_id = ${companyId}::UUID AND asset_id = ${assetId}::UUID
  `) as DbRow[];

  const row = rows[0];
  // No subledger history: the asset column is the only opening there is.
  const base = row?.base == null ? Number(row?.asset_column ?? 0) : Number(row.base);
  return {
    openingForPeriod: round2(base + Number(row?.before_period ?? 0)),
    accumulatedElsewhere: round2(base + Number(row?.other_periods ?? 0)),
  };
}

/**
 * Writes the asset's cached tax accumulation and book value, clamped to cost.
 *
 * Safe as an absolute SET only because `lockAssetTaxBase` holds the row lock for
 * the rest of the transaction and `total` was derived from a subledger read
 * taken after it was granted.
 *
 * `total` can EXCEED cost on damaged history. Before this defect was fixed the
 * opening was always the un-accumulating asset column, so `remaining = cost -
 * opening` never fell to zero and a full month was charged for as many periods
 * as the run was made — any asset with more posted periods than its tax life in
 * months carries that history. Unclamped, `cost - total` then writes a NEGATIVE
 * `tax_book_value`: an asset with 70 periods of 2 000 against a 120 000 cost
 * lands at -20 000, which reaches the FAR report, while `dispose.ts` values
 * recoupment off an accumulation larger than the asset ever cost. Nothing may
 * be depreciated below nil for tax, so both are bounded — and warned about,
 * because a total above cost means the subledger is corrupt and someone has to
 * look rather than read a plausible zero.
 */
export async function writeAssetTaxAccumulation(
  companyId: string,
  assetId: string,
  cost: number,
  total: number,
): Promise<void> {
  const capped = Math.min(round2(total), round2(cost));
  if (round2(total) > round2(cost)) {
    log.warn('Tax accumulated depreciation exceeds cost — capping', {
      assetId, companyId, cost: round2(cost), charged: round2(total),
    }, 'accounting');
  }
  await sql`
    UPDATE assets SET
      tax_accumulated_depreciation = ${capped},
      tax_book_value = ${Math.max(0, round2(cost - capped))},
      updated_at = NOW()
    WHERE id = ${assetId}::UUID AND company_id = ${companyId}::UUID
  `;
}
