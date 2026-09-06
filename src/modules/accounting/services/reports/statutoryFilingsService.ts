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

export async function getOverdueStatutoryFilings(companyId: string): Promise<OverdueFiling[]> {
  const rows = (await sql`
    SELECT d.fiscal_year, c.financial_year_start
    FROM afs_documents d
    JOIN companies c ON c.id = d.company_id
    WHERE d.company_id = ${companyId}::UUID
      AND d.document_type = 'afs'
      AND d.status NOT IN ('signed_off', 'filed')
  `) as Array<Record<string, unknown>>;

  const now = Date.now();
  const overdue: OverdueFiling[] = [];
  for (const row of rows) {
    const fiscalYear = row.fiscal_year as number;
    const fyStartMonth = (row.financial_year_start as number) || 3;
    const deadline = fiscalYearEndPlusSixMonths(fiscalYear, fyStartMonth);
    const daysOverdue = Math.floor((now - deadline.getTime()) / (1000 * 60 * 60 * 24));

    if (daysOverdue > 0) {
      overdue.push({
        filingType: 'Annual Financial Statements',
        fiscalYear,
        deadline: deadline.toISOString().slice(0, 10),
        daysOverdue,
      });
    }
  }
  return overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);
}
