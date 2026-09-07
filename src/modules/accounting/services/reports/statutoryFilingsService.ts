/**
 * Overdue statutory filings for the board pack's page 11.
 *
 * Scoped to the one filing this schema actually tracks a deadline for: the
 * Annual Financial Statements, computed as fiscal year-end plus six months —
 * the same rule `complianceAlertService`'s `detectFilingDeadlineAlerts` uses
 * for its approaching-deadline alerts, applied here to entries where that
 * deadline has already passed.
 *
 * CIPC annual-return and VAT/EMP filing due dates are NOT included.
 * `complianceAlertService`'s own `detectCipcOverdueAlerts` is a stub, with
 * the reason recorded in its comment: `companies.cipc_annual_return_due` does
 * not exist. Inventing a due date for a filing this schema has no column for
 * would be a false statement about compliance on a board pack, which is
 * worse than the gap this file leaves instead.
 */

import { sql } from '@/lib/neon';

export interface OverdueFiling {
  filingType: string;
  fiscalYear: number;
  deadline: string;
  daysOverdue: number;
}

function fiscalYearEndPlusSixMonths(fiscalYear: number, financialYearStartMonth: number): Date {
  const endMonth = financialYearStartMonth === 1 ? 12 : financialYearStartMonth - 1;
  const lastDay = new Date(fiscalYear, endMonth, 0).getDate();
  const yearEnd = new Date(fiscalYear, endMonth - 1, lastDay);
  const deadline = new Date(yearEnd);
  deadline.setMonth(deadline.getMonth() + 6);
  return deadline;
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
function wholeDaysBetween(deadline: Date, asAt: string): number {
  const [y, m, d] = asAt.split('-').map(Number);
  return Math.round((Date.UTC(y!, m! - 1, d!) - utcMidnightOf(deadline)) / 86_400_000);
}

function utcMidnightOf(local: Date): number {
  return Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
}

/**
 * THE DEADLINE AS THE CALENDAR DAY IT IS, NOT AS AN INSTANT SHIFTED WEST.
 *
 * It was `deadline.toISOString().slice(0, 10)`. `fiscalYearEndPlusSixMonths`
 * builds a LOCAL date, so on this server (UTC+2) local midnight on 28 August
 * is 27 August 22:00Z and the pack printed a due date one day before the one
 * its own count was measured from. The board pack put both on the page — "due
 * 28 August 2024 … 739 days overdue" — so the two halves of the same sentence
 * disagreed by a day.
 */
function calendarDateOf(local: Date): string {
  return new Date(utcMidnightOf(local)).toISOString().slice(0, 10);
}

export async function getOverdueStatutoryFilings(
  companyId: string,
  /** The pack's reporting date, `YYYY-MM-DD` — the date every printed date on
   *  the sheet is measured to. A filing is overdue AS AT that date, not as at
   *  whenever the render happened to run. */
  asAt: string,
): Promise<OverdueFiling[]> {
  const rows = (await sql`
    SELECT d.fiscal_year, c.financial_year_start
    FROM afs_documents d
    JOIN companies c ON c.id = d.company_id
    WHERE d.company_id = ${companyId}::UUID
      AND d.document_type = 'afs'
      AND d.status NOT IN ('signed_off', 'filed')
  `) as Array<Record<string, unknown>>;

  const overdue: OverdueFiling[] = [];
  for (const row of rows) {
    const fiscalYear = row.fiscal_year as number;
    const fyStartMonth = (row.financial_year_start as number) || 3;
    const deadline = fiscalYearEndPlusSixMonths(fiscalYear, fyStartMonth);
    const daysOverdue = wholeDaysBetween(deadline, asAt);

    if (daysOverdue > 0) {
      overdue.push({
        filingType: 'Annual Financial Statements',
        fiscalYear,
        deadline: calendarDateOf(deadline),
        daysOverdue,
      });
    }
  }
  return overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);
}
