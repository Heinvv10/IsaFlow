/**
 * Depreciation methods — the annual policy charge under each of the three
 * methods `assets.depreciation_method` allows, and the two statements about a
 * schedule that depend only on it.
 *
 * The PERIOD calculator that turns an annual charge into one month's journal
 * lives in `policyDepreciation.ts`; both were split out of
 * `farDepreciationService.ts`, which re-exports everything.
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

/**
 * The warning for an asset whose useful life has run out with book value still
 * on it. Null for the ordinary case.
 *
 * A monthly run charges such an asset nothing — `annualPolicyCharge` is zero
 * past the life and the true-up fires only in the life's last month. Writing
 * the balance off is a deliberate prior-period correction, so the run names the
 * amount rather than sweeping it into one month's journal.
 */
export function lifeExpiredNote(a: {
  cost: number;
  residual: number;
  usefulLifeYears: number;
  monthsElapsed: number;
  policyAccDep: number;
  periodDate: string;
}): string | null {
  if (a.usefulLifeYears <= 0 || a.cost <= 0) return null;
  if (a.monthsElapsed < Math.round(a.usefulLifeYears * 12)) return null;
  const remaining = round2(a.cost - a.residual - a.policyAccDep);
  if (remaining <= 0) return null;
  return (
    `Its ${a.usefulLifeYears}-year life ended before ${a.periodDate} with `
    + `${remaining.toFixed(2)} of policy book value still undepreciated. This run charges `
    + 'nothing for it — writing the balance off is a prior-period correction, not a month of '
    + 'depreciation. Its tax track, which may have life left, still posts.'
  );
}
