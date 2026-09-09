/**
 * Policy (IAS 16) depreciation for ONE period.
 *
 * Takes the annual charge for the asset's method from `depreciationMethods.ts`
 * and turns it into the month's journal: the first-month pro-rate, the
 * final-month true-up onto the residual, and the cap at the remaining
 * depreciable amount. Pure business logic — no DB dependencies.
 */

import {
  annualPolicyCharge,
  monthsBetween,
  type DepreciationMethod,
} from './depreciationMethods';

export interface PolicyDepreciationInput {
  cost: number;
  /** Residual value as a fraction of cost (0.10 = 10%). IAS 16: depreciable = cost × (1 − residualPct). */
  residualPct: number;
  usefulLifeYears: number;
  /** ISO date string — used to pro-rate the first month. */
  purchaseDate: string;
  /** ISO date string — last day of the period being computed. */
  periodDate: string;
  /** Accumulated policy depreciation from all prior periods (default 0). */
  openingAccDep?: number;
  /** If set and falls within this period, depreciation = 0 for the period. */
  disposalDate?: string;
  /** The asset's configured method. Omitted = straight line. */
  method?: DepreciationMethod;
}

export interface PolicyDepreciationResult {
  monthlyDep: number;
  annualDep: number;
  openingAccDep: number;
  closingAccDep: number;
  policyCarryingAmount: number;
  depRate: number;
}

function parseDate(d: string | Date): Date {
  return typeof d === 'string' ? new Date(d) : d;
}

/** Days in a given month (year, 0-based month). */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Returns true when the disposalDate falls on or before the last day of the
 * period (i.e. disposal occurred during or before this period).
 */
function disposedInOrBeforePeriod(disposalDate: string | undefined, periodDate: Date): boolean {
  if (!disposalDate) return false;
  const dd = parseDate(disposalDate);
  return dd <= periodDate;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Policy Depreciation (IAS 16) ─────────────────────────────────────────────

/**
 * Calculates monthly policy (IAS 16) depreciation for a single period.
 *
 * Rules:
 * - Annual charge per the asset's method (see annualPolicyCharge); straight
 *   line on depreciable amount (cost × (1 − residualPct)) when unset
 * - Pro-rates the first month based on days remaining after purchase date
 * - Trues the schedule up in the final month of the life, so every method
 *   charges the depreciable amount exactly and then stops
 * - Caps at remaining depreciable amount (cannot over-depreciate)
 * - Zero depreciation in any period after disposal
 */
export function calculatePolicyDepreciation(input: PolicyDepreciationInput): PolicyDepreciationResult {
  const {
    cost,
    residualPct,
    usefulLifeYears,
    purchaseDate,
    periodDate: periodDateStr,
    openingAccDep = 0,
    disposalDate,
    method = 'straight_line',
  } = input;

  const periodDate = parseDate(periodDateStr);

  if (disposedInOrBeforePeriod(disposalDate, periodDate)) {
    return {
      monthlyDep: 0,
      annualDep: 0,
      openingAccDep,
      closingAccDep: openingAccDep,
      policyCarryingAmount: round2(cost - openingAccDep),
      depRate: 0,
    };
  }

  const depreciableAmount = round2(cost * (1 - residualPct));
  if (depreciableAmount <= 0 || usefulLifeYears <= 0) {
    return {
      monthlyDep: 0,
      annualDep: 0,
      openingAccDep,
      closingAccDep: openingAccDep,
      policyCarryingAmount: round2(cost - openingAccDep),
      depRate: 0,
    };
  }

  const pd = parseDate(purchaseDate);
  const monthsElapsed = monthsBetween(pd, periodDate);

  const annualDep = annualPolicyCharge({
    method,
    cost,
    residual: round2(cost - depreciableAmount),
    usefulLifeYears,
    monthsElapsed,
  });
  const fullMonthlyDep = round2(annualDep / 12);
  const depRate = round2((annualDep / cost) * 100) / 100;

  // Pro-rate first period if asset was purchased part-way through the month
  const periodYear = periodDate.getFullYear();
  const periodMonth = periodDate.getMonth();
  const purchaseYear = pd.getFullYear();
  const purchaseMonth = pd.getMonth();

  let monthlyDep = fullMonthlyDep;

  const isFirstMonth =
    purchaseYear === periodYear && purchaseMonth === periodMonth;

  if (isFirstMonth) {
    const totalDays = daysInMonth(periodYear, periodMonth);
    // Days from purchase day to end of month (inclusive of purchase date)
    const daysRemaining = totalDays - pd.getDate() + 1;
    monthlyDep = round2(fullMonthlyDep * (daysRemaining / totalDays));
  }

  // Cap at remaining depreciable amount
  const remainingDepreciable = round2(depreciableAmount - openingAccDep);
  if (remainingDepreciable <= 0) {
    return {
      monthlyDep: 0,
      annualDep,
      openingAccDep,
      closingAccDep: openingAccDep,
      policyCarryingAmount: round2(cost - openingAccDep),
      depRate,
    };
  }

  // Final month of the useful life — and ONLY that month: charge whatever is
  // left, so the schedule lands exactly on the residual and ends there. Every
  // method loses part of a month to the first-month pro-rate; sum-of-years and
  // reducing balance both stop at the life and would otherwise strand it on the
  // register forever.
  //
  // The comparison is equality, not >=. An asset already PAST its life with
  // book value still on it — what a part-migrated register is full of — would
  // otherwise be handed its entire remaining book value as one month's charge
  // on the first run after deploy. A catch-up of that size is a prior-period
  // correction under IAS 8, not this month's depreciation; `planDepreciationRun`
  // reports it instead (see `lifeExpiredNote`).
  if (monthsElapsed === Math.round(usefulLifeYears * 12) - 1) monthlyDep = remainingDepreciable;

  monthlyDep = round2(Math.min(monthlyDep, remainingDepreciable));

  const closingAccDep = round2(openingAccDep + monthlyDep);
  const policyCarryingAmount = round2(cost - closingAccDep);

  return { monthlyDep, annualDep, openingAccDep, closingAccDep, policyCarryingAmount, depRate };
}
