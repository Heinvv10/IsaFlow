// src/modules/accounting/services/afs/pisCalculatorService.ts
// Public Interest Score (PIS) calculator — Regulation 26(2) of Companies Act 71 of 2008
// Queries live GL for revenue + liabilities, companies table for employee/shareholder counts.

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PisScore } from './afsTypes';

// ── Types ───────────────────────────────────────────────────────────────────

export interface PisBreakdown {
  employees: { beginning: number; end: number; average: number; points: number };
  turnover: { amount: number; points: number };
  thirdPartyLiabilities: { amount: number; points: number };
  shareholders: { count: number; points: number };
  totalScore: number;
  allShareholdersAreDirectors: boolean;
  reportingRequirement: 'mandatory_audit' | 'independent_review' | 'voluntary';
  requiredFramework: 'ifrs_smes' | 'full_ifrs';
  requiredCipcFiling: 'fas_only' | 'afs_required';
  dataUnavailable: string[];
  calculatedAt: string;
}

// ── Internal helpers ──────────────────────────────────────��───────────────────

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

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Compute PIS score for a given fiscal year range (ISO date strings).
 * Revenue and third-party liabilities from GL. Employee/shareholder counts from companies table.
 */
export async function computePisScore(
  companyId: string,
  fiscalYearStart: string,
  fiscalYearEnd: string
): Promise<PisScore> {
  log.info('pisCalculatorService: computing PIS score', { companyId, fiscalYearStart, fiscalYearEnd });

  const [revenueRows, liabilityRows, companyRows] = await Promise.all([
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
    sql`
      SELECT
        COALESCE(employee_count_beginning, 0) AS emp_begin,
        COALESCE(employee_count_end, 0) AS emp_end,
        COALESCE(shareholder_count, 1) AS sh_count,
        COALESCE(all_shareholders_are_directors, true) AS all_dirs
      FROM companies
      WHERE id = ${companyId}::UUID
    ` as Promise<Record<string, unknown>[]>,
  ]);

  const totalRevenue = Number(revenueRows[0]?.total_revenue ?? 0);
  const totalLiabilities = Number(liabilityRows[0]?.total_liabilities ?? 0);

  const company = companyRows[0];
  const empBegin = Number(company?.emp_begin ?? 0);
  const empEnd = Number(company?.emp_end ?? 0);
  const empAverage = roundTo2((empBegin + empEnd) / 2);
  const shCount = Number(company?.sh_count ?? 1);
  const allDirectors = company?.all_dirs === true;

  // Points = ZAR amount / 1_000_000, rounded to 2 dp
  const turnoverPoints = roundTo2(totalRevenue / 1_000_000);
  const liabilityPoints = roundTo2(totalLiabilities / 1_000_000);
  const employeePoints = roundTo2(empAverage);
  const shareholderPoints = roundTo2(shCount);

  const total = roundTo2(turnoverPoints + liabilityPoints + employeePoints + shareholderPoints);

  const { requiredFramework, requiredAudit, requiredCipcFiling } = deriveRequirements(total, allDirectors);

  // Track which fields are still at defaults (potential data unavailable)
  const dataUnavailable: string[] = [];
  if (empBegin === 0 && empEnd === 0) dataUnavailable.push('employee_count');

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
    dataUnavailable,
    calculatedAt: new Date().toISOString(),
  };
}

/**
 * Detailed breakdown for the PIS dashboard UI — includes component amounts and averages.
 */
export async function computePisBreakdown(
  companyId: string,
  fiscalYearStart: string,
  fiscalYearEnd: string,
): Promise<PisBreakdown> {
  const [revenueRows, liabilityRows, companyRows] = await Promise.all([
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
    sql`
      SELECT
        COALESCE(employee_count_beginning, 0) AS emp_begin,
        COALESCE(employee_count_end, 0) AS emp_end,
        COALESCE(shareholder_count, 1) AS sh_count,
        COALESCE(all_shareholders_are_directors, true) AS all_dirs
      FROM companies
      WHERE id = ${companyId}::UUID
    ` as Promise<Record<string, unknown>[]>,
  ]);

  const totalRevenue = Number(revenueRows[0]?.total_revenue ?? 0);
  const totalLiabilities = Number(liabilityRows[0]?.total_liabilities ?? 0);
  const company = companyRows[0];
  const empBegin = Number(company?.emp_begin ?? 0);
  const empEnd = Number(company?.emp_end ?? 0);
  const empAverage = roundTo2((empBegin + empEnd) / 2);
  const shCount = Number(company?.sh_count ?? 1);
  const allDirectors = company?.all_dirs === true;

  const turnoverPoints = roundTo2(totalRevenue / 1_000_000);
  const liabilityPoints = roundTo2(totalLiabilities / 1_000_000);
  const employeePoints = roundTo2(empAverage);
  const shareholderPoints = roundTo2(shCount);
  const totalScore = roundTo2(turnoverPoints + liabilityPoints + employeePoints + shareholderPoints);

  const { requiredFramework, requiredAudit, requiredCipcFiling } = deriveRequirements(totalScore, allDirectors);

  const dataUnavailable: string[] = [];
  if (empBegin === 0 && empEnd === 0) dataUnavailable.push('employee_count');

  return {
    employees: { beginning: empBegin, end: empEnd, average: empAverage, points: employeePoints },
    turnover: { amount: totalRevenue, points: turnoverPoints },
    thirdPartyLiabilities: { amount: totalLiabilities, points: liabilityPoints },
    shareholders: { count: shCount, points: shareholderPoints },
    totalScore,
    allShareholdersAreDirectors: allDirectors,
    reportingRequirement: requiredAudit,
    requiredFramework,
    requiredCipcFiling,
    dataUnavailable,
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
