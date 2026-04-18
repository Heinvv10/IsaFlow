/**
 * SDL Calculation Report API
 * GET /api/payroll/payroll-sdl?year=YYYY
 *
 * Returns per-month SDL breakdown for the full tax year, scoped to company.
 * SDL rate: 1% of total gross leviable earnings (per SARS).
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const SDL_RATE = 0.01;

export interface SdlMonthResult {
  month: string;   // YYYY-MM
  gross: number;
  sdl: number;
  employeeCount: number;
}

export interface SdlYearResult {
  year: string;
  months: SdlMonthResult[];
  yearTotal: {
    gross: number;
    sdl: number;
  };
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { year } = req.query;
  if (!year || typeof year !== 'string' || !/^\d{4}$/.test(year)) {
    return apiResponse.badRequest(res, 'year parameter is required in YYYY format');
  }

  const yearNum = parseInt(year, 10);
  if (yearNum < 2000 || yearNum > 2100) {
    return apiResponse.badRequest(res, 'year must be between 2000 and 2100');
  }

  try {
    const yearStart = `${year}-01-01`;
    const yearEnd   = `${year}-12-31`;

    // Aggregate by month using payslip data for accuracy
    const rows = (await sql`
      SELECT
        TO_CHAR(pr.period_start, 'YYYY-MM')          AS month,
        COALESCE(SUM(ps.gross_pay), 0)               AS gross,
        COALESCE(SUM(ps.sdl), 0)                     AS sdl_stored,
        COUNT(DISTINCT ps.employee_id)               AS employee_count
      FROM payroll_runs pr
      JOIN payslips ps ON ps.payroll_run_id = pr.id
      WHERE pr.company_id = ${companyId}::UUID
        AND pr.status IN ('draft', 'completed')
        AND pr.period_start >= ${yearStart}::DATE
        AND pr.period_start <= ${yearEnd}::DATE
      GROUP BY TO_CHAR(pr.period_start, 'YYYY-MM')
      ORDER BY month
    `) as Row[];

    // Build a full 12-month grid, filling in zero for months with no data
    const dataMap = new Map<string, { gross: number; sdl: number; employeeCount: number }>();
    for (const r of rows) {
      const grossVal = Math.round(Number(r.gross) * 100) / 100;
      // Use stored SDL if present, otherwise derive at 1%
      const storedSdl = Math.round(Number(r.sdl_stored) * 100) / 100;
      const derivedSdl = Math.round(grossVal * SDL_RATE * 100) / 100;
      dataMap.set(String(r.month), {
        gross: grossVal,
        sdl: storedSdl > 0 ? storedSdl : derivedSdl,
        employeeCount: Number(r.employee_count) || 0,
      });
    }

    const months: SdlMonthResult[] = [];
    for (let m = 1; m <= 12; m++) {
      const monthStr = `${year}-${String(m).padStart(2, '0')}`;
      const data = dataMap.get(monthStr) ?? { gross: 0, sdl: 0, employeeCount: 0 };
      months.push({ month: monthStr, ...data });
    }

    const yearTotal = months.reduce(
      (acc, m) => ({ gross: acc.gross + m.gross, sdl: acc.sdl + m.sdl }),
      { gross: 0, sdl: 0 }
    );

    const result: SdlYearResult = {
      year,
      months,
      yearTotal: {
        gross: Math.round(yearTotal.gross * 100) / 100,
        sdl:   Math.round(yearTotal.sdl * 100) / 100,
      },
    };

    log.info('SDL report fetched', { companyId, year, totalSdl: result.yearTotal.sdl }, 'payroll-sdl');
    return apiResponse.success(res, result);
  } catch (err) {
    log.error('SDL GET failed', { error: err }, 'payroll-sdl');
    return apiResponse.internalError(res, err, 'Failed to fetch SDL report');
  }
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withAuth>[0]));
