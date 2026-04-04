/**
 * EMP501 Bi-Annual Reconciliation API
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { buildEMP501Summary, type EMP501MonthlyData } from '@/modules/accounting/services/irp5Service';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const parsedTaxYear = Number(req.query.taxYear);
  const taxYear = parsedTaxYear >= 2000 && parsedTaxYear <= 2100 ? parsedTaxYear : new Date().getFullYear();

  // Get monthly totals from payroll runs
  const rows = await sql`
    SELECT
      EXTRACT(MONTH FROM pr.period_end) as month,
      COALESCE(SUM(ps.paye), 0) as paye,
      COALESCE(SUM(ps.uif_employee + ps.uif_employer), 0) as uif,
      COALESCE(SUM(ps.sdl), 0) as sdl,
      COUNT(DISTINCT ps.employee_id) as total_employees
    FROM payroll_runs pr
    JOIN payslips ps ON ps.payroll_run_id = pr.id
    WHERE pr.period_end >= ${`${taxYear - 1}-03-01`}
      AND pr.period_end <= ${`${taxYear}-02-28`}
    GROUP BY EXTRACT(MONTH FROM pr.period_end)
    ORDER BY month
  ` as Row[];

  const monthlyData: EMP501MonthlyData[] = rows.map((r: any) => ({
    month: Number(r.month),
    paye: Number(r.paye),
    uif: Number(r.uif),
    sdl: Number(r.sdl),
    totalEmployees: Number(r.total_employees),
  }));

  const summary = buildEMP501Summary(monthlyData, taxYear);
  return apiResponse.success(res, summary);
}

export default withCompany(withErrorHandler(handler));
