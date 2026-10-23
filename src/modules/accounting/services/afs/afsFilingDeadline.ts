/**
 * WHEN A COMPANY'S ANNUAL FINANCIAL STATEMENTS FALL DUE — one rule.
 *
 * Six months after the fiscal year end (Companies Act s30(1)). Two services
 * need it: `statutoryFilingsService` lists the statements already overdue as
 * at a board pack's date, and `complianceAlertService` warns as the deadline
 * approaches. Each had its own copy, and both copies were wrong the same two
 * ways — see the functions below. The year end is the end date of the
 * company's registry year with that label (`gl/fiscalYearRegistry`), so a
 * 14-month transition year falls due six months after ITS end.
 */
import { getFiscalYear } from '@/modules/accounting/services/gl/fiscalYearRegistry';

/**
 * No financial year carries the label, so no deadline can be stated for its
 * statements. Its own class so a caller that reports a failed check can tell
 * this refusal from a crash.
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
 * `gl/fiscalYearRegistry.ts` for why dates stay strings on a UTC+2 host.
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
 * The date the statements for `fiscalYear` fall due, 'YYYY-MM-DD'.
 *
 * @throws FilingDeadlineUnknownError where the company has no financial year
 *   with that label.
 */
export async function afsFilingDeadline(companyId: string, fiscalYear: number): Promise<string> {
  const year = await getFiscalYear(companyId, fiscalYear);
  if (!year) {
    throw new FilingDeadlineUnknownError(
      `Company ${companyId} has no financial year labelled ${fiscalYear}, so no filing deadline can be stated for it.`,
    );
  }
  return sixMonthsAfterYearEnd(year.endDate);
}
