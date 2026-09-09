/**
 * The PLAN half of the monthly depreciation run: every guard, nothing written.
 *
 * `planDepreciationRun` runs the checks and `executeDepreciationRun`
 * (`depreciationRunService.ts`) writes without re-checking. A dry run is
 * therefore the first WITHOUT the second, which makes it structurally incapable
 * of passing where the live call would refuse — `dry_run` parity by
 * construction rather than by two code paths agreeing.
 *
 * The route's original eligibility filter lived in a WHERE clause, so an asset
 * it excluded simply never appeared. Here each exclusion is a ROW with a
 * machine-stable reason: "there are no depreciable assets" and "every asset is
 * disposed" are different facts, and a caller acting unattended needs the
 * second one.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { isRealCalendarDate } from '@/lib/validation';

/** Statuses the run treats as in-service. Anything else is not depreciated. */
export const IN_SERVICE_STATUSES = ['available', 'assigned', 'in_maintenance'] as const;

export type DepreciationSkipReason =
  | 'not_in_service'
  | 'not_yet_acquired'
  | 'no_purchase_price'
  | 'below_capitalisation_threshold'
  | 'no_useful_life'
  | 'already_posted'
  | 'already_in_subledger';

export interface DepreciationPlanRow {
  assetId: string;
  assetNumber: string;
  name: string;
  cost: number;
  /** Entry number the journal would carry — derived from periodDate. */
  entryNumber: string;
  /** Null when the row would post; set when it would be skipped. */
  skipReason: DepreciationSkipReason | null;
  skipDetail: string | null;
}

export type DepreciationBlocker =
  | { reason: 'invalid_period_date'; detail: string }
  | { reason: 'no_period'; detail: string }
  | { reason: 'period_closed'; detail: string };

export interface DepreciationPlan {
  periodDate: string;
  yyyymm: string;
  fiscalPeriodId: string | null;
  /** Set when the run must refuse outright. Nothing may be written. */
  blocker: DepreciationBlocker | null;
  rows: DepreciationPlanRow[];
  /** Rows that would post. */
  postable: DepreciationPlanRow[];
  /** Assets matching the route's original eligibility filter — its `total`. */
  eligibleTotal: number;
}

/**
 * `period_date` must be a real calendar day in canonical `YYYY-MM-DD`.
 *
 * Postgres ACCEPTS `2026-9-30`, so a non-canonical date reaches the DATE
 * columns intact — but `periodDate.slice(0, 7)` then yields `2026-9-` and the
 * entry number becomes `DEP-<asset>-2026-9-`, which does NOT collide with
 * `DEP-<asset>-2026-09`. The `already_posted` guard never sees it and a second
 * September journal posts for the same asset. The guard lives here rather than
 * in either caller so the REST route and the MCP tool cannot diverge on it.
 */
export function invalidPeriodDate(periodDate: string): DepreciationBlocker | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(periodDate) && isRealCalendarDate(periodDate)) return null;
  return {
    reason: 'invalid_period_date',
    detail:
      `period_date "${periodDate}" is not a real calendar day in YYYY-MM-DD form. `
      + 'Postgres would accept a value like 2026-9-30 and it would produce a DIFFERENT '
      + 'entry number from 2026-09-30, defeating the already-posted guard and posting the '
      + 'same period twice.',
  };
}

/** Last day of the current month, in local components. */
export function defaultPeriodDate(now: Date = new Date()): string {
  return fmtDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
}

export function yyyymmFor(periodDate: string): string {
  return periodDate.replace(/-/g, '').slice(0, 6);
}

/** `DEP-<asset>-YYYY-MM`, from the PERIOD being depreciated, never from today. */
export function depreciationEntryNumber(assetNumber: string, periodDate: string): string {
  return `DEP-${assetNumber}-${periodDate.slice(0, 7)}`;
}

/** Assets plus the category policy each one inherits. */
export async function loadDepreciationAssets(companyId: string): Promise<DbRow[]> {
  return (await sql`
    SELECT
      a.id, a.asset_number, a.name, a.status,
      a.purchase_price                              AS cost,
      a.purchase_date,
      COALESCE(a.below_threshold, false)            AS below_threshold,
      COALESCE(a.accumulated_depreciation, 0)       AS policy_acc_dep,
      COALESCE(a.tax_accumulated_depreciation, 0)   AS tax_acc_dep,
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
async function alreadyPosted(companyId: string, numbers: string[]): Promise<Set<string>> {
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
 * Assets already holding an `asset_period_ledger` row — the run’s ON CONFLICT
 * key. `alreadyPosted` misses these: the GL post returns early on a policy charge
 * of zero, so an asset at policy 0 with tax still running takes no entry number
 * and would re-run for ever off the balance the last run wrote.
 */
async function alreadyInSubledger(companyId: string, yyyymm: string): Promise<Set<string>> {
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
async function resolvePeriod(
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

export async function planDepreciationRun(
  companyId: string,
  periodDate: string,
  assets: DbRow[],
): Promise<DepreciationPlan> {
  const invalid = invalidPeriodDate(periodDate);
  const period = invalid
    ? { id: null, blocker: invalid }
    : await resolvePeriod(companyId, periodDate);
  const numbers = assets.map(
    (a) => depreciationEntryNumber(String(a.asset_number ?? ''), periodDate),
  );
  const posted = await alreadyPosted(companyId, numbers);
  const inSubledger = await alreadyInSubledger(companyId, yyyymmFor(periodDate));

  const rows: DepreciationPlanRow[] = [];
  let eligibleTotal = 0;

  for (const a of assets) {
    const assetNumber = String(a.asset_number ?? '');
    const entryNumber = depreciationEntryNumber(assetNumber, periodDate);
    const cost = Number(a.cost);
    const usefulLifeYears = Number(a.useful_life_years ?? 0);
    const status = String(a.status ?? '');
    const purchaseDate = a.purchase_date == null ? null : fmtDate(a.purchase_date);

    const base = {
      assetId: String(a.id),
      assetNumber,
      name: String(a.name ?? ''),
      cost: Number.isFinite(cost) ? cost : 0,
      entryNumber,
    };
    const skip = (reason: DepreciationSkipReason, detail: string): void => {
      rows.push({ ...base, skipReason: reason, skipDetail: detail });
    };

    if (!(IN_SERVICE_STATUSES as readonly string[]).includes(status)) {
      skip('not_in_service', `Status is "${status}"; only ${IN_SERVICE_STATUSES.join(', ')} are depreciated.`);
      continue;
    }

    if (a.cost == null || !Number.isFinite(cost) || cost <= 0) {
      skip('no_purchase_price', 'No purchase price, so there is nothing to depreciate.');
      continue;
    }
    if (a.below_threshold === true) {
      skip('below_capitalisation_threshold', 'Marked below the capitalisation threshold; it was expensed, not capitalised.');
      continue;
    }

    // Matches the route's original WHERE clause exactly — this is its `total`.
    eligibleTotal += 1;

    // An asset cannot be depreciated in a period that ENDS before it was
    // acquired, and nothing downstream stops it.
    // `calculatePolicyDepreciation` decides its first-month pro-rate by
    // EQUALITY on purchase year and month, so a period BEFORE the purchase
    // matches neither branch and falls through to a FULL month's charge,
    // capped only by `depreciableAmount - openingAccDep` — a quantity with no
    // relation to elapsed time. The journal posts dated in that period and
    // `assets.accumulated_depreciation` is incremented permanently, once per
    // open pre-acquisition period.
    //
    // That calculator was written for a caller that always ran the CURRENT
    // month; `period_date` is an agent-supplied argument and voids the
    // assumption. This is a PER-ASSET skip and not a whole-run blocker: a
    // register holding one asset bought last week must still be able to run
    // for the months before it, for every other asset.
    if (purchaseDate !== null && purchaseDate > periodDate) {
      skip(
        'not_yet_acquired',
        `Acquired ${purchaseDate}, after the period ending ${periodDate}. Depreciating it here `
        + 'would post a full month of charge for a month in which the asset did not exist.',
      );
      continue;
    }

    if (usefulLifeYears <= 0) {
      skip('no_useful_life', 'No useful life on the asset or its category, so no depreciation can be computed.');
      continue;
    }
    if (posted.has(entryNumber)) {
      skip('already_posted', `${entryNumber} is already posted for this period and has not been reversed.`);
      continue;
    }
    // Its own reason: no live journal means no policy charge, or a reversal.
    if (inSubledger.has(String(a.id))) {
      skip('already_in_subledger', `The subledger already holds ${yyyymmFor(periodDate)} for `
        + 'this asset; a re-run would recompute it from the balance the first run wrote.');
      continue;
    }

    rows.push({ ...base, skipReason: null, skipDetail: null });
  }

  return {
    periodDate,
    yyyymm: yyyymmFor(periodDate),
    fiscalPeriodId: period.id,
    blocker: period.blocker,
    rows,
    postable: rows.filter((r) => r.skipReason === null),
    eligibleTotal,
  };
}
