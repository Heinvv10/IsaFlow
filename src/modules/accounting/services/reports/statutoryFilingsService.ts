/**
 * Overdue statutory filings for the board pack's page 11.
 *
 * Scoped to the one filing this schema actually tracks a deadline for: the
 * Annual Financial Statements, due six months after the fiscal year end
 * (Companies Act s30(1)), applied here to entries where that deadline has
 * already passed. The deadline itself is `afs/afsFilingDeadline.ts`, the one
 * rule this service and the approaching-deadline alert both read.
 *
 * CIPC annual-return and VAT/EMP filing due dates are NOT included.
 * `complianceAlertService`'s own `detectCipcOverdueAlerts` is a stub, with
 * the reason recorded in its comment: `companies.cipc_annual_return_due` does
 * not exist. Inventing a due date for a filing this schema has no column for
 * would be a false statement about compliance on a board pack, which is
 * worse than the gap this file leaves instead.
 */

import { sql } from '@/lib/neon';
import { afsFilingDeadline, wholeDaysBetween } from '@/modules/accounting/services/afs/afsFilingDeadline';

// Thrown by the deadline rule; re-exported because callers of this service
// name it from here.
export { FilingDeadlineUnknownError } from '@/modules/accounting/services/afs/afsFilingDeadline';

export interface OverdueFiling {
  filingType: string;
  fiscalYear: number;
  deadline: string;
  daysOverdue: number;
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
    SELECT d.fiscal_year
    FROM afs_documents d
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
    const deadline = await afsFilingDeadline(companyId, fiscalYear);
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
