/**
 * EMP201 Monthly Return API
 * GET /api/payroll/payroll-emp201?month=YYYY-MM
 *
 * Aggregates PAYE, UIF, and SDL totals for a given month from payroll_runs
 * and payslips, scoped to the authenticated company.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface Emp201Result {
  month: string;
  totalGross: number;
  totalPaye: number;
  totalUifEmployee: number;
  totalUifEmployer: number;
  totalSdl: number;
  totalLiability: number;
  employeeCount: number;
  payrollRunIds: string[];
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { month } = req.query;
  if (!month || typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    return apiResponse.badRequest(res, 'month parameter is required in YYYY-MM format');
  }

  try {
    // Resolve the month to a date range
    const periodStart = `${month}-01`;
    // Last day of month via DATE_TRUNC + interval
    const runRows = (await sql`
      SELECT
        pr.id,
        pr.total_gross,
        pr.total_paye,
        pr.total_uif_employee,
        pr.total_uif_employer,
        pr.total_sdl
      FROM payroll_runs pr
      WHERE pr.company_id = ${companyId}::UUID
        AND pr.status IN ('draft', 'completed')
        AND pr.period_start >= ${periodStart}::DATE
        AND pr.period_start < (DATE_TRUNC('month', ${periodStart}::DATE) + INTERVAL '1 month')
      ORDER BY pr.period_start
    `) as Row[];

    if (runRows.length === 0) {
      const empty: Emp201Result = {
        month,
        totalGross: 0,
        totalPaye: 0,
        totalUifEmployee: 0,
        totalUifEmployer: 0,
        totalSdl: 0,
        totalLiability: 0,
        employeeCount: 0,
        payrollRunIds: [],
      };
      return apiResponse.success(res, empty);
    }

    const payrollRunIds = runRows.map((r: Row) => String(r.id));

    // Aggregate payslip-level totals for accuracy
    const aggRows = (await sql`
      SELECT
        COALESCE(SUM(ps.gross_pay), 0)     AS total_gross,
        COALESCE(SUM(ps.paye), 0)          AS total_paye,
        COALESCE(SUM(ps.uif_employee), 0)  AS total_uif_employee,
        COALESCE(SUM(ps.uif_employer), 0)  AS total_uif_employer,
        COALESCE(SUM(ps.sdl), 0)           AS total_sdl,
        COUNT(DISTINCT ps.employee_id)     AS employee_count
      FROM payslips ps
      WHERE ps.payroll_run_id = ANY(${payrollRunIds}::UUID[])
    `) as Row[];

    const agg = aggRows[0]!;
    const totalGross       = Math.round(Number(agg.total_gross) * 100) / 100;
    const totalPaye        = Math.round(Number(agg.total_paye) * 100) / 100;
    const totalUifEmployee = Math.round(Number(agg.total_uif_employee) * 100) / 100;
    const totalUifEmployer = Math.round(Number(agg.total_uif_employer) * 100) / 100;
    const totalSdl         = Math.round(Number(agg.total_sdl) * 100) / 100;
    const employeeCount    = Number(agg.employee_count) || 0;

    const totalLiability = Math.round(
      (totalPaye + totalUifEmployee + totalUifEmployer + totalSdl) * 100
    ) / 100;

    const result: Emp201Result = {
      month,
      totalGross,
      totalPaye,
      totalUifEmployee,
      totalUifEmployer,
      totalSdl,
      totalLiability,
      employeeCount,
      payrollRunIds,
    };

    log.info('EMP201 fetched', { companyId, month, totalLiability }, 'payroll-emp201');
    return apiResponse.success(res, result);
  } catch (err) {
    log.error('EMP201 GET failed', { error: err }, 'payroll-emp201');
    return apiResponse.internalError(res, err, 'Failed to fetch EMP201 data');
  }
}

export default withCompany(withErrorHandler(handler as Parameters<typeof withCompany>[0]));
