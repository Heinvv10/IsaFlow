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

interface RunRow {
  id: string;
  period_month: number;
  period_year: number;
  status: string;
}

interface CompanyRow {
  name: string;
  tax_year_start_month: number | null;
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  // SA tax year starts March (month 3) by default. financial_year_start is the
  // company's own start month; we use it as the tax-year anchor.
  const companyRows = (await sql`
    SELECT name, COALESCE(financial_year_start, 3) AS tax_year_start_month
      FROM companies WHERE id = ${companyId} LIMIT 1
  `) as unknown as CompanyRow[];

  if (companyRows.length === 0) {
    return apiResponse.notFound(res, 'Company', companyId);
  }
  const company = companyRows[0]!;
  const taxYearStartMonth = company.tax_year_start_month ?? 3;

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
  const periodNumber =
    ((periodMonth - taxYearStartMonth + 12) % 12) + 1;

  return apiResponse.success(res, {
    companyName: company.name,
    periodMonth,
    periodYear,
    periodNumber,
    periodsInTaxYear: 12,
    runId,
    status,
    taxYearStartMonth,
  });
}

export default withAuth(withErrorHandler(handler));
