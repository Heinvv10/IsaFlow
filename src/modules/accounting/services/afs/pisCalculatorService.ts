// src/modules/accounting/services/afs/pisCalculatorService.ts
// Public Interest Score (PIS) calculator — queries live GL for revenue + liabilities.
// Employee and shareholder counts are stubbed (columns do not exist on companies yet).

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PisScore } from './afsTypes';

// ── Internal helpers ──────────────────────────────────────────────────────────

function deriveRequirements(total: number, allDirectors: boolean): {
  requiredFramework: PisScore['requiredFramework'];
  requiredAudit: PisScore['requiredAudit'];
  requiredCipcFiling: PisScore['requiredCipcFiling'];
} {
  if (total >= 350) {
    return {
      requiredFramework: 'full_ifrs',
      requiredAudit: 'mandatory_audit',
      requiredCipcFiling: 'afs_required',
    };
  }

  if (total >= 100) {
    return {
      requiredFramework: 'ifrs_smes',
      requiredAudit: 'independent_review',
      requiredCipcFiling: 'afs_required',
    };
  }

  // PIS < 100
  if (allDirectors) {
    return {
      requiredFramework: 'ifrs_smes',
      requiredAudit: 'voluntary',
      requiredCipcFiling: 'fas_only',
    };
  }

  // Conservative default: assume external shareholders present
  return {
    requiredFramework: 'ifrs_smes',
    requiredAudit: 'independent_review',
    requiredCipcFiling: 'afs_required',
  };
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Compute PIS score for a given fiscal year range (ISO date strings).
 * Revenue and third-party liabilities are pulled from the GL via 3-table join.
 * Employee count and shareholder count are stubbed to 0.
 */
export async function computePisScore(
  companyId: string,
  fiscalYearStart: string,
  fiscalYearEnd: string
): Promise<PisScore> {
  log.info('pisCalculatorService: computing PIS score', { companyId, fiscalYearStart, fiscalYearEnd });

  const [revenueRows, liabilityRows] = await Promise.all([
    sql`
      SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS total_revenue
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.status = 'posted'
        AND ga.account_type = 'revenue'
        AND je.entry_date >= ${fiscalYearStart}
        AND je.entry_date <= ${fiscalYearEnd}
    ` as Promise<Record<string, unknown>[]>,
    sql`
      SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS total_liabilities
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.status = 'posted'
        AND ga.account_type = 'liability'
        AND (ga.account_subtype IS NULL
             OR ga.account_subtype NOT IN ('equity_loan', 'shareholder_loan'))
        AND je.entry_date <= ${fiscalYearEnd}
    ` as Promise<Record<string, unknown>[]>,
  ]);

  const totalRevenue = Number(revenueRows[0]?.total_revenue ?? 0);
  const totalLiabilities = Number(liabilityRows[0]?.total_liabilities ?? 0);

  // Points = ZAR amount / 1_000_000, rounded to 2 dp
  const turnoverPoints = Math.round((totalRevenue / 1_000_000) * 100) / 100;
  const liabilityPoints = Math.round((totalLiabilities / 1_000_000) * 100) / 100;
  const employeePoints = 0;    // Stubbed — companies.employee_count does not exist
  const shareholderPoints = 0; // Stubbed — companies.shareholder_count does not exist

  const total = Math.round((turnoverPoints + liabilityPoints + employeePoints + shareholderPoints) * 100) / 100;

  // companies.all_shareholders_are_directors does not exist — default false (conservative)
  const allDirectors = false;
  const { requiredFramework, requiredAudit, requiredCipcFiling } = deriveRequirements(total, allDirectors);

  log.info('pisCalculatorService: PIS computed', { companyId, total, requiredFramework, requiredAudit });

  return {
    turnoverPoints,
    employeePoints,
    shareholderPoints,
    liabilityPoints,
    total,
    requiredFramework,
    requiredAudit,
    requiredCipcFiling,
    dataUnavailable: ['employee_count', 'shareholder_count'],
    calculatedAt: new Date().toISOString(),
  };
}

/**
 * Convenience wrapper — reads fiscal year dates from afs_documents for a given documentId.
 * Tenant-scoped: verifies document belongs to companyId.
 */
export async function computePisScoreForDocument(
  companyId: string,
  documentId: string
): Promise<PisScore> {
  const rows = (await sql`
    SELECT d.fiscal_year, c.financial_year_start
    FROM afs_documents d
    JOIN companies c ON c.id = d.company_id
    WHERE d.id = ${documentId}::UUID
      AND d.company_id = ${companyId}::UUID
  `) as Record<string, unknown>[];

  if (rows.length === 0) {
    throw new Error(`AFS document ${documentId} not found for company ${companyId}`);
  }

  // rows.length >= 1 is guaranteed by the check above
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const { fiscal_year, financial_year_start } = rows[0]!;
  const fyStartMonth = (financial_year_start as number) || 3; // default March if null
  const year = fiscal_year as number;

  // Fiscal year start: first day of fyStartMonth in the prior year (if fyStartMonth > 1)
  const startYear = fyStartMonth > 1 ? year - 1 : year;
  const fiscalYearStart = `${startYear}-${String(fyStartMonth).padStart(2, '0')}-01`;

  // Fiscal year end: last day of month before fyStartMonth in the fiscal year
  let endMonth: number;
  let endYear: number;
  if (fyStartMonth === 1) {
    endMonth = 12;
    endYear = year;
  } else {
    endMonth = fyStartMonth - 1;
    endYear = year;
  }
  const lastDay = new Date(endYear, endMonth, 0).getDate();
  const fiscalYearEnd = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  return computePisScore(companyId, fiscalYearStart, fiscalYearEnd);
}
