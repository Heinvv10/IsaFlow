/**
 * The fiscal-year calendar — the one place a company's `financial_year_start`
 * month becomes period boundaries.
 *
 * WHY THIS EXISTS. `createFiscalYear` built January–December for every company
 * while every production company carries `financial_year_start = 3`. Brightsphere
 * therefore has 72 fiscal periods, not one of which lines up with the year its
 * AFS is signed for, and `closeFiscalYear` rolls the wrong twelve months into
 * retained earnings. Meanwhile `ensureFiscalPeriodForDate` read the fiscal year
 * off the first four characters of the date string, which is the calendar year
 * and is wrong for ten months out of twelve on a March start.
 *
 * PURE ON PURPOSE. No DB, no `Date` arithmetic that crosses a timezone, no
 * `toISOString()` — this server runs at UTC+2 and `new Date(y, m, d)` rendered
 * through `toISOString()` rolls back a day, which is exactly how journals landed
 * one period early (migrations 523/524). Everything here is built from integer
 * components and formatted by hand.
 *
 * THE LABELLING CONVENTION IS NOT NEW. `afs/pisCalculatorService` already reads
 * the column this way: a fiscal year is named for the calendar year it ENDS in,
 * so FY2027 on a March start runs 1 March 2026 → 28 February 2027. That is the
 * SA convention ("year ended 28 February 2027"). A second convention would be a
 * second derivation, which is the failure this file exists to remove.
 */

/**
 * What `financial_year_start` means when the column is NULL or 0.
 *
 * March, matching the SA tax year and every company in production. Callers that
 * read the column apply this themselves — it lives here so there is one value to
 * change rather than the five ad-hoc `|| 3` fallbacks the codebase grew.
 */
export const FISCAL_YEAR_DEFAULT_START_MONTH = 3;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export interface FiscalPeriodDef {
  /** 1-based position WITHIN the fiscal year, not the calendar month. */
  periodNumber: number;
  /** e.g. "March 2026" — the calendar month the period actually covers. */
  periodName: string;
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  /** YYYY-MM-DD, inclusive. */
  endDate: string;
}

export interface FiscalYearRange {
  startDate: string;
  endDate: string;
}

function assertStartMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`invalid financial year start month: ${month} (expected 1–12)`);
  }
}

/** Days in a calendar month, leap years included. `month` is 1-based. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the NEXT month is the last day of this one, evaluated in local
  // time and read back as integer components — no ISO rendering involved.
  return new Date(year, month, 0).getDate();
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The calendar (year, month) that is `offset` months after (year, month). */
function addMonths(year: number, month: number, offset: number): { year: number; month: number } {
  const zeroBased = (month - 1) + offset;
  return {
    year: year + Math.floor(zeroBased / 12),
    month: (((zeroBased % 12) + 12) % 12) + 1,
  };
}

/**
 * First and last day of the fiscal year labelled `fiscalYear`.
 *
 * A January start is the identity case and keeps the calendar year it names;
 * every other start month begins in the PRIOR calendar year.
 */
export function fiscalYearRange(fiscalYear: number, startMonth: number): FiscalYearRange {
  assertStartMonth(startMonth);
  if (startMonth === 1) {
    return { startDate: iso(fiscalYear, 1, 1), endDate: iso(fiscalYear, 12, 31) };
  }
  const endMonth = startMonth - 1;
  return {
    startDate: iso(fiscalYear - 1, startMonth, 1),
    endDate: iso(fiscalYear, endMonth, daysInMonth(fiscalYear, endMonth)),
  };
}

/** The twelve monthly periods of a fiscal year, in fiscal order. */
export function buildFiscalYearPeriods(fiscalYear: number, startMonth: number): FiscalPeriodDef[] {
  const { startDate } = fiscalYearRange(fiscalYear, startMonth);
  const firstYear = Number(startDate.slice(0, 4));

  return Array.from({ length: 12 }, (_, index) => {
    const { year, month } = addMonths(firstYear, startMonth, index);
    const last = daysInMonth(year, month);
    return {
      periodNumber: index + 1,
      periodName: `${MONTH_NAMES[month - 1]} ${year}`,
      startDate: iso(year, month, 1),
      endDate: iso(year, month, last),
    };
  });
}

/**
 * Which fiscal year a date belongs to.
 *
 * The boundary is the whole point: on a March start, 2026-02-28 is FY2026 and
 * 2026-03-01 is FY2027. Reading the calendar year off the date string — which
 * `ensureFiscalPeriodForDate` did — is right for two months a year and wrong for
 * the other ten, and the failure is silent: no period covers the date, the
 * journal posts with `fiscal_period_id` NULL, and it is then invisible to the
 * trial balance, the VAT201 and the AFS.
 */
export function fiscalYearOfDate(date: string | Date, startMonth: number): number {
  assertStartMonth(startMonth);

  let year: number;
  let month: number;
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) throw new Error('invalid date');
    // Local components, deliberately: a DATE column read at UTC+2 is a local
    // midnight, and getUTC* would move it to the previous day.
    year = date.getFullYear();
    month = date.getMonth() + 1;
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
    if (!match) throw new Error(`invalid date: ${date}`);
    year = Number(match[1]);
    month = Number(match[2]);
    if (month < 1 || month > 12) throw new Error(`invalid date: ${date}`);
  }

  if (startMonth === 1) return year;
  return month >= startMonth ? year + 1 : year;
}

/** True when the fiscal year and the calendar year are the same twelve months. */
export function isCalendarAligned(startMonth: number): boolean {
  assertStartMonth(startMonth);
  return startMonth === 1;
}

/** Normalise a `companies.financial_year_start` column value, NULL included. */
export function normaliseStartMonth(raw: unknown): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 12
    ? value
    : FISCAL_YEAR_DEFAULT_START_MONTH;
}
