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
 * Narrows a DB string to a method, falling back to straight line.
 *
 * `assets.depreciation_method` is NOT NULL DEFAULT 'straight_line', so the
 * asset row always carries a value and the method — unlike useful life,
 * residual and tax life — does NOT inherit from `asset_categories`. The
 * `diminishing_balance` arm folds that table's spelling of reducing balance
 * onto this one for any caller that reads a category row directly; no run path
 * does today.
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

/** Whole months from the acquisition month to the period month; 0 = first month. */
export function monthsBetween(purchaseDate: Date, periodDate: Date): number {
  const months =
    (periodDate.getFullYear() - purchaseDate.getFullYear()) * 12
    + (periodDate.getMonth() - purchaseDate.getMonth());
  return months <= 0 ? 0 : months;
}

export interface MethodChargeInput {
  method: DepreciationMethod;
  cost: number;
  /** Absolute residual value, NOT a fraction of cost. */
  residual: number;
  usefulLifeYears: number;
  /** Whole months from the acquisition month to the period month; 0 = first month. */
  monthsElapsed: number;
}

/**
 * The double-declining charge for one depreciation year, walked from cost.
 *
 * Crossover: once spreading the remaining depreciable amount evenly over the
 * remaining life exceeds the declining charge, the schedule switches to that.
 * Without it the geometric series only approaches the residual and never
 * reaches it — a five-year asset still carried 13.1% of cost at the end of its
 * life and the run posted a shrinking journal for it every month forever.
 */
function decliningYearCharge(a: MethodChargeInput, yearIndex: number): number {
  const rate = 2 / a.usefulLifeYears;
  let carrying = a.cost;
  for (let k = 0; k <= yearIndex; k += 1) {
    const remainingDepreciable = carrying - a.residual;
    if (remainingDepreciable <= 0) return 0;
    const charge = Math.min(
      Math.max(carrying * rate, remainingDepreciable / (a.usefulLifeYears - k)),
      remainingDepreciable,
    );
    if (k === yearIndex) return charge;
    carrying -= charge;
  }
  return 0;
}

/**
 * The annual charge for the depreciation YEAR the period falls in.
 *
 * Deterministic in `monthsElapsed`: it does NOT read accumulated depreciation,
 * so all twelve months of a year carry the same rate. Deriving the declining
 * charge from the running accumulated balance instead compounded the rate
 * monthly and charged 33.4% of cost in year one where the stated rate is 40%.
 *
 * - straight_line: depreciable amount spread evenly over the life.
 * - reducing_balance: 2 / life on the year-opening carrying amount, with the
 *   straight-line crossover (see decliningYearCharge).
 * - sum_of_years: depreciable amount × remaining years / n(n+1)/2.
 *
 * Zero once the useful life has run out. The caller trues the schedule up in
 * its final month, so the pro-rated first month is not stranded.
 */
export function annualPolicyCharge(a: MethodChargeInput): number {
  const depreciable = a.cost - a.residual;
  if (depreciable <= 0 || a.usefulLifeYears <= 0) return 0;

  const yearIndex = Math.floor(a.monthsElapsed / 12);
  const remainingYears = a.usefulLifeYears - yearIndex;
  if (remainingYears <= 0) return 0;

  if (a.method === 'reducing_balance') return round2(decliningYearCharge(a, yearIndex));
  if (a.method === 'sum_of_years') {
    const sumOfDigits = (a.usefulLifeYears * (a.usefulLifeYears + 1)) / 2;
    return round2((depreciable * remainingYears) / sumOfDigits);
  }
  return round2(depreciable / a.usefulLifeYears);
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

  // Final month of the useful life: charge whatever is left, so the schedule
  // lands exactly on the residual and ends there. Every method loses part of a
  // month to the first-month pro-rate; sum-of-years and reducing balance both
  // stop at the life and would otherwise strand it on the register forever.
  if (monthsElapsed >= Math.round(usefulLifeYears * 12) - 1) monthlyDep = remainingDepreciable;

  monthlyDep = round2(Math.min(monthlyDep, remainingDepreciable));

  const closingAccDep = round2(openingAccDep + monthlyDep);
  const policyCarryingAmount = round2(cost - closingAccDep);

  return { monthlyDep, annualDep, openingAccDep, closingAccDep, policyCarryingAmount, depRate };
}
