/**
 * WHEN A COMPANY'S ANNUAL FINANCIAL STATEMENTS FALL DUE — one rule.
 *
 * Six months after the fiscal year end (Companies Act s30(1)). Two services
 * need it: `statutoryFilingsService` lists the statements already overdue as
 * at a board pack's date, and `complianceAlertService` warns as the deadline
 * approaches. Each had its own copy, and both copies were wrong the same two
 * ways — see the functions below. The year end comes from
 * `afsFiscalPeriod.fiscalRangeFor`, the one place that says which twelve
 * months a fiscal year covers.
 */
import { fiscalRangeFor } from './afsFiscalPeriod';
import { resolveFiscalYearStartMonth } from '@/modules/accounting/services/gl/fiscalYearBasis';

/**
 * The company's financial year start is unusable, so no deadline can be
 * stated for its statements. Its own class so a caller that reports a failed
 * check can tell this refusal from a crash.
 */
export class FilingDeadlineUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilingDeadlineUnknownError';
  }
}

/**
 * SIX MONTHS AFTER A YEAR END IS THE END OF THE SIXTH MONTH.
 *
 * It was `setMonth(getMonth() + 6)` on the last day of the year-end month,
 * which keeps the day NUMBER and lets the month absorb the overflow: 31 March
 * became 1 October, 31 December 1 July, 31 August 3 March, and 28 February
 * stopped at 28 August with three days of the month still to run. A year end
 * is always a month end, so the deadline is too.
 *
 * Arithmetic on the numbers of a 'YYYY-MM-DD' string, never a local Date: see
 * `afsFiscalPeriod.ts` for what a Date round-trip does on a UTC+2 host.
 */
function sixMonthsAfterYearEnd(yearEnd: string): string {
  const [year, month] = yearEnd.split('-').map(Number);
  const monthIndex = year! * 12 + (month! - 1) + 6;
  const dueYear = Math.floor(monthIndex / 12);
  const dueMonth = (monthIndex % 12) + 1;
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(dueYear, dueMonth, 0)).getUTCDate();
  return `${String(dueYear).padStart(4, '0')}-${String(dueMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * WHOLE CALENDAR DAYS BETWEEN THE DEADLINE AND THE DATE THE PACK IS ABOUT.
 *
 * It was `Math.floor((Date.now() - deadline) / 86_400_000)`, and the board
 * pack it feeds printed "739 days overdue" on a sheet whose cover, footer,
 * period line and extraction timestamp all said 7 September 2026 — 739 is the
 * count to the 6th. Two errors in one expression: the anchor was the wall
 * clock rather than the date the pack reports to, and a floor over a
 * millisecond difference measures elapsed time rather than calendar days, so
 * the answer moved with the hour a pack was rendered.
 *
 * Both dates are read as calendar days in UTC before subtracting, so no local
 * offset or DST hour can move the count.
 */
export function wholeDaysBetween(deadline: string, asAt: string): number {
  return Math.round((utcMidnightOf(asAt) - utcMidnightOf(deadline)) / 86_400_000);
}

function utcMidnightOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

/**
 * NO MARCH FALLBACK. It was `|| 3`, which `afsFiscalPeriod.ts` forbids for the
 * reason it gives: a tenant whose setting is missing is told a deadline a
 * quarter out with nothing flagging it. Refused instead, by name.
 */
function fyStartMonthOf(raw: unknown, companyId: string): number {
  try {
    return resolveFiscalYearStartMonth(raw, companyId);
  } catch (error) {
    throw new FilingDeadlineUnknownError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The date the statements for `fiscalYear` fall due, 'YYYY-MM-DD'.
 *
 * @param rawFinancialYearStart `companies.financial_year_start` as read.
 * @throws FilingDeadlineUnknownError where that value is not a month.
 */
export function afsFilingDeadline(
  fiscalYear: number,
  rawFinancialYearStart: unknown,
  companyId: string,
): string {
  return sixMonthsAfterYearEnd(
    fiscalRangeFor(fiscalYear, fyStartMonthOf(rawFinancialYearStart, companyId)).end,
  );
}
