/**
 * Overdue statutory filings for the board pack's page 11.
 *
 * Scoped to the one filing this schema actually tracks a deadline for: the
 * Annual Financial Statements, due six months after the fiscal year end
 * (Companies Act s30(1)), applied here to entries where that deadline has
 * already passed. The year end comes from `afsFiscalPeriod.fiscalRangeFor`,
 * the one place that says which twelve months a fiscal year covers.
 *
 * CIPC annual-return and VAT/EMP filing due dates are NOT included.
 * `complianceAlertService`'s own `detectCipcOverdueAlerts` is a stub, with
 * the reason recorded in its comment: `companies.cipc_annual_return_due` does
 * not exist. Inventing a due date for a filing this schema has no column for
 * would be a false statement about compliance on a board pack, which is
 * worse than the gap this file leaves instead.
 */

import { sql } from '@/lib/neon';
import { fiscalRangeFor } from '@/modules/accounting/services/afs/afsFiscalPeriod';
import { resolveFiscalYearStartMonth } from '@/modules/accounting/services/gl/fiscalYearBasis';

export interface OverdueFiling {
  filingType: string;
  fiscalYear: number;
  deadline: string;
  daysOverdue: number;
}

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
function wholeDaysBetween(deadline: string, asAt: string): number {
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

export async function getOverdueStatutoryFilings(
  companyId: string,
  /** The pack's reporting date, `YYYY-MM-DD` — the date every printed date on
   *  the sheet is measured to. A filing is overdue AS AT that date, not as at
   *  whenever the render happened to run. */
  asAt: string,
): Promise<OverdueFiling[]> {
  // OUTSTANDING AS AT THE PACK DATE, not as at the render. Every writer that
  // sets `signed_off` stamps `locked_at`, so statements signed off AFTER the
  // date a pack reports to were still outstanding on it, and a re-rendered
  // historical pack must go on saying so. A signed-off row with no stamp
  // cannot be dated and stays out, as it did before.
  const rows = (await sql`
    SELECT d.fiscal_year, c.financial_year_start
    FROM afs_documents d
    JOIN companies c ON c.id = d.company_id
    WHERE d.company_id = ${companyId}::UUID
      AND d.document_type = 'afs'
      AND d.fiscal_year IS NOT NULL
      AND (
        d.status NOT IN ('signed_off', 'filed')
        OR (d.locked_at AT TIME ZONE 'Africa/Johannesburg')::DATE > ${asAt}::DATE
      )
  `) as Array<Record<string, unknown>>;

  const overdue: OverdueFiling[] = [];
  for (const row of rows) {
    const fiscalYear = Number(row.fiscal_year);
    const deadline = sixMonthsAfterYearEnd(
      fiscalRangeFor(fiscalYear, fyStartMonthOf(row.financial_year_start, companyId)).end,
    );
    const daysOverdue = wholeDaysBetween(deadline, asAt);

    if (daysOverdue > 0) {
      overdue.push({
        filingType: 'Annual Financial Statements',
        fiscalYear,
        deadline,
        daysOverdue,
      });
    }
  }
  return overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);
}
