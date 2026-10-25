/**
 * GET /api/payroll/period-context
 *
 * Returns the company's name + the most recent payroll run's period & status,
 * formatted for the persistent period bar shown on every /payroll/* page.
 *
 * If no run exists yet, returns the current calendar month + status='none'.
 */

import type { NextApiResponse } from 'next';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import {
  PAYE_PERIODS_IN_TAX_YEAR,
  PAYE_TAX_YEAR_START_MONTH,
  payeTaxPeriodNumber,
} from '@/modules/accounting/utils/payeTaxYear';

interface RunRow {
  id: string;
  period_month: number;
  period_year: number;
  status: string;
}

interface CompanyRow {
  name: string;
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  // The PAYE tax year is always March-February, whatever the company's own
  // financial year end (companies.financial_year_start is the books' year).
  const companyRows = (await sql`
    SELECT name FROM companies WHERE id = ${companyId} LIMIT 1
  `) as unknown as CompanyRow[];

  if (companyRows.length === 0) {
    return apiResponse.notFound(res, 'Company', companyId);
  }
  const company = companyRows[0]!;

  const runRows = (await sql`
    SELECT id, period_month, period_year, status
      FROM payroll_run_headers
     WHERE company_id = ${companyId}
     ORDER BY period_year DESC, period_month DESC
     LIMIT 1
  `) as unknown as RunRow[];

  const today = new Date();
  let periodMonth: number;
  let periodYear: number;
  let runId: string | null = null;
  let status: string;

  if (runRows.length > 0) {
    const r = runRows[0]!;
    periodMonth = r.period_month;
    periodYear = r.period_year;
    runId = r.id;
    status = r.status;
  } else {
    periodMonth = today.getMonth() + 1;
    periodYear = today.getFullYear();
    status = 'none';
  }

  // SA-style period numbering: Period 1 = first month of tax year.
  const periodNumber = payeTaxPeriodNumber(periodMonth);

  return apiResponse.success(res, {
    companyName: company.name,
    periodMonth,
    periodYear,
    periodNumber,
    periodsInTaxYear: PAYE_PERIODS_IN_TAX_YEAR,
    runId,
    status,
    taxYearStartMonth: PAYE_TAX_YEAR_START_MONTH,
  });
}

export default withAuth(withErrorHandler(handler));
