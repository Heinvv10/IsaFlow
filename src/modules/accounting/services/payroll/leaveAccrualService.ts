/**
 * Leave Accrual Engine — pure TS, no DB.
 * Applies BCEA accrual rules to produce expected balances from employee
 * start date + accrual configuration. Designed to be called idempotently:
 * callers UPSERT `accrued = max(current, computeExpectedAccrual(...))` so
 * re-running the monthly job does not double-count.
 */

export type AccrualRule = 'monthly' | 'cycle_30_per_36' | 'none';

export interface AccrualInput {
  /** Employee hire date (ISO 'YYYY-MM-DD'). Accrual starts from this date. */
  employeeStart: string;
  /** Optional leaving date. Accrual stops on this date. */
  employeeEnd?: string | null;
  /** The end of the period you are accruing to (ISO 'YYYY-MM-DD'). */
  asOf: string;
  /** Year-of-accrual boundary ISO 'YYYY-MM-DD' (Jan 1 for calendar year, or company cycle start). */
  yearStart: string;
  /** Leave-type accrual rule. */
  accrualRule: AccrualRule;
  /** Days accrued per month for 'monthly'. For 'cycle_30_per_36' this is ignored (30 / 36 ≈ 0.833/mo). */
  accrualDays: number;
}

function parseIso(iso: string): Date {
  // Parse YYYY-MM-DD as a UTC date to avoid TZ drift between dev machines.
  const [y, m, d] = iso.slice(0, 10).split('-').map((n) => Number(n));
  return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
}

function monthsBetween(fromDate: Date, toDateInclusive: Date): number {
  if (toDateInclusive < fromDate) return 0;
  // Whole calendar months elapsed, pro-rated on day-of-month so mid-month
  // starts/ends give fractional credit.
  const years = toDateInclusive.getUTCFullYear() - fromDate.getUTCFullYear();
  const months = toDateInclusive.getUTCMonth() - fromDate.getUTCMonth();
  const days = toDateInclusive.getUTCDate() - fromDate.getUTCDate();
  const totalMonths = years * 12 + months + days / 30;
  return Math.max(0, totalMonths);
}

/** Round a day count to 2 decimals to match the DB NUMERIC(6,2) precision. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Expected accrued days for a leave type as at `asOf`, from the effective
 * start of the year (or employee hire date, whichever is later).
 */
export function computeExpectedAccrual(input: AccrualInput): number {
  if (input.accrualRule === 'none') return 0;

  const start = parseIso(input.employeeStart);
  const yearStart = parseIso(input.yearStart);
  const asOf = parseIso(input.asOf);
  const end = input.employeeEnd ? parseIso(input.employeeEnd) : null;

  // Effective window: start = max(employeeStart, yearStart), end = min(asOf, employeeEnd ?? asOf)
  const effStart = start > yearStart ? start : yearStart;
  const effEnd = end && end < asOf ? end : asOf;
  if (effEnd < effStart) return 0;

  const months = monthsBetween(effStart, effEnd);

  if (input.accrualRule === 'monthly') {
    return round2(months * input.accrualDays);
  }

  // cycle_30_per_36: BCEA sick leave — 30 days per 36 months ≈ 0.8333 days/month.
  if (input.accrualRule === 'cycle_30_per_36') {
    return round2(months * (30 / 36));
  }

  return 0;
}

/**
 * Apply max-carry-over cap to a year-end balance.
 *   - Negative balances → 0 (never carry a deficit into the new year).
 *   - If maxCarryOver is null, unlimited carry.
 *   - If maxCarryOver is a number (incl. 0), cap at that value.
 */
export function computeCarryOver(balance: number, maxCarryOver: number | null): number {
  const positive = Math.max(0, balance);
  if (maxCarryOver === null || maxCarryOver === undefined) return round2(positive);
  return round2(Math.min(positive, maxCarryOver));
}

/**
 * Convenience: end-of-month date for (year, month) in ISO. month is 1-12.
 * Used by the monthly-accrual helper so callers don't recompute month-end.
 */
export function endOfMonthIso(year: number, month: number): string {
  // Day 0 of the next month = last day of this month, in UTC.
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}
