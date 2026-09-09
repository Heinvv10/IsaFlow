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

import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { isRealCalendarDate } from '@/lib/validation';
import { lifeExpiredNote, monthsBetween } from './depreciationMethods';
import { alreadyInSubledger, alreadyPosted, resolvePeriod } from './depreciationRunQueries';

// The run's three reads live in `depreciationRunQueries.ts`. Re-exported: this
// module is the entry point every caller already imports.
export { loadDepreciationAssets } from './depreciationRunQueries';

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
  /**
   * Set when the asset's useful life has already expired while policy book
   * value remains. The row still POSTS — its tax track may have life left — but
   * the policy charge is zero and the remaining amount will never be charged by
   * a monthly run. Reported rather than silently swept into one month's
   * journal; see the equality guard in `calculatePolicyDepreciation`.
   */
  lifeExpiredNote?: string;
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

    const note = purchaseDate === null ? null : lifeExpiredNote({
      cost,
      residual: Number(a.residual_pct ?? 0) * cost,
      usefulLifeYears,
      monthsElapsed: monthsBetween(new Date(purchaseDate), new Date(periodDate)),
      policyAccDep: Number(a.policy_acc_dep ?? 0),
      periodDate,
    });
    rows.push({ ...base, skipReason: null, skipDetail: null, ...(note ? { lifeExpiredNote: note } : {}) });
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
