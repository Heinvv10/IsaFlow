/**
 * Depreciation methods — the annual policy charge under each of the three
 * methods `assets.depreciation_method` allows.
 *
 * Split out of `farDepreciationService.ts`, which was at the 300-line cap.
 * Pure business logic — no DB dependencies.
 */

/** The three methods `assets.depreciation_method` is CHECK-constrained to (migration 244). */
export type DepreciationMethod = 'straight_line' | 'reducing_balance' | 'sum_of_years';

/**
 * Narrows a DB string to a method. `asset_categories.depreciation_method`
 * (migration 360) uses `diminishing_balance` for what `assets` calls
 * `reducing_balance`, so the two vocabularies are folded here rather than
 * assumed equal. Anything unrecognised falls back to straight line.
 */
export function toDepreciationMethod(value: unknown): DepreciationMethod {
  const v = String(value ?? '');
  if (v === 'reducing_balance' || v === 'diminishing_balance') return 'reducing_balance';
  if (v === 'sum_of_years') return 'sum_of_years';
  return 'straight_line';
}

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

/** Whole years elapsed from the acquisition month to the period month. */
export function elapsedYears(purchaseDate: Date, periodDate: Date): number {
  const months =
    (periodDate.getFullYear() - purchaseDate.getFullYear()) * 12
    + (periodDate.getMonth() - purchaseDate.getMonth());
  return months <= 0 ? 0 : Math.floor(months / 12);
}

/**
 * The annual charge for the period under the asset's configured method.
 *
 * - straight_line: depreciable amount spread evenly over the life.
 * - reducing_balance: double-declining — carrying amount × 2 / life. The charge
 *   falls every year because the carrying amount does; the caller's remaining
 *   depreciable cap still stops it crossing the residual.
 * - sum_of_years: depreciable amount × remaining years / n(n+1)/2.
 */
export function annualPolicyCharge(a: {
  method: DepreciationMethod;
  cost: number;
  depreciableAmount: number;
  usefulLifeYears: number;
  openingAccDep: number;
  purchaseDate: Date;
  periodDate: Date;
}): number {
  if (a.method === 'reducing_balance') {
    const carrying = a.cost - a.openingAccDep;
    if (carrying <= 0) return 0;
    return round2(carrying * (2 / a.usefulLifeYears));
  }
  if (a.method === 'sum_of_years') {
    const n = Math.ceil(a.usefulLifeYears);
    const remaining = n - elapsedYears(a.purchaseDate, a.periodDate);
    if (remaining <= 0) return 0;
    return round2((a.depreciableAmount * remaining) / ((n * (n + 1)) / 2));
  }
  return round2(a.depreciableAmount / a.usefulLifeYears);
}

// ─── Policy Depreciation (IAS 16) ─────────────────────────────────────────────

/**
 * Calculates monthly policy (IAS 16) depreciation for a single period.
 *
 * Rules:
 * - Annual charge per the asset's method (see annualPolicyCharge); straight
 *   line on depreciable amount (cost × (1 − residualPct)) when unset
 * - Pro-rates the first month based on days remaining after purchase date
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

  const annualDep = annualPolicyCharge({
    method,
    cost,
    depreciableAmount,
    usefulLifeYears,
    openingAccDep,
    purchaseDate: pd,
    periodDate,
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

  monthlyDep = round2(Math.min(monthlyDep, remainingDepreciable));

  const closingAccDep = round2(openingAccDep + monthlyDep);
  const policyCarryingAmount = round2(cost - closingAccDep);

  return { monthlyDep, annualDep, openingAccDep, closingAccDep, policyCarryingAmount, depRate };
}
