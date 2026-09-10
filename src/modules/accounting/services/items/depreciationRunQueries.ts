/**
 * The four database reads the depreciation run makes. Every other decision in
 * `depreciationRunPlan.ts` is pure, so keeping the SQL here leaves the planner
 * testable without a database and the planner under the 300-line cap.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { DepreciationBlocker } from './depreciationRunPlan';

/** Assets plus the category policy each one inherits. */
export async function loadDepreciationAssets(companyId: string): Promise<DbRow[]> {
  return (await sql`
    SELECT
      a.id, a.asset_number, a.name, a.status,
      a.purchase_price                              AS cost,
      a.purchase_date,
      a.depreciation_method,
      COALESCE(a.below_threshold, false)            AS below_threshold,
      COALESCE(a.accumulated_depreciation, 0)       AS policy_acc_dep,
      COALESCE(a.tax_opening_acc_dep, 0)            AS tax_opening_acc_dep,
      COALESCE(a.deferred_tax_rate, 0.27)           AS deferred_tax_rate,
      a.disposal_date,
      COALESCE(a.useful_life_years, c.useful_life_years)                        AS useful_life_years,
      COALESCE(a.salvage_value / NULLIF(a.purchase_price, 0), c.residual_pct, 0) AS residual_pct,
      COALESCE(a.tax_useful_life_years, c.tax_life_years)                        AS tax_life_years
    FROM assets a
    LEFT JOIN asset_categories c ON c.id = a.category_id
    WHERE a.company_id = ${companyId}::UUID
    ORDER BY a.asset_number, a.id
  `) as DbRow[];
}

/** Entry numbers already posted for this period, so a re-run is a skip. */
export async function alreadyPosted(companyId: string, numbers: string[]): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  const rows = (await sql`
    SELECT entry_number FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID
      AND entry_number = ANY(${numbers}::TEXT[])
      AND reversed_at IS NULL
  `) as DbRow[];
  return new Set(rows.map((r) => String(r.entry_number)));
}

/**
 * Assets already holding an `asset_period_ledger` row — the run's ON CONFLICT
 * key. `alreadyPosted` misses these: the GL post returns early on a policy charge
 * of zero, so an asset at policy 0 with tax still running takes no entry number
 * and would re-run for ever off the balance the last run wrote.
 */
export async function alreadyInSubledger(companyId: string, yyyymm: string): Promise<Set<string>> {
  const rows = (await sql`
    SELECT asset_id FROM asset_period_ledger
    WHERE company_id = ${companyId}::UUID AND yyyymm = ${yyyymm}
  `) as DbRow[];
  return new Set(rows.map((r) => String(r.asset_id)));
}

/**
 * The fiscal period covering the date, and whether it blocks the run.
 *
 * `postAssetDepreciationToGLThrows` INSERTs `gl_journal_entries` directly at
 * status `posted`, so it never reaches `postJournalEntry`'s closed-period
 * check and a depreciation run could post into a closed month. `no_period` and
 * `period_closed` are different refusals because the remedies differ: create
 * the fiscal year, versus re-open the period.
 */
export async function resolvePeriod(
  companyId: string,
  periodDate: string,
): Promise<{ id: string | null; blocker: DepreciationBlocker | null }> {
  const rows = (await sql`
    SELECT id, status, period_name FROM fiscal_periods
    WHERE company_id = ${companyId}::UUID
      AND ${periodDate}::DATE BETWEEN start_date AND end_date
    LIMIT 1
  `) as DbRow[];
  const row = rows[0];
  if (!row) {
    return {
      id: null,
      blocker: {
        reason: 'no_period',
        detail:
          `No fiscal period covers ${periodDate}. Create the fiscal year first — a journal `
          + 'posted with no period sits outside the trial balance, the VAT201 and the AFS.',
      },
    };
  }
  const status = String(row.status ?? '');
  if (status !== 'open') {
    return {
      id: String(row.id),
      blocker: {
        reason: 'period_closed',
        detail:
          `Fiscal period ${String(row.period_name ?? '')} covering ${periodDate} is `
          + `"${status}". Re-open it before running depreciation.`,
      },
    };
  }
  return { id: String(row.id), blocker: null };
}
