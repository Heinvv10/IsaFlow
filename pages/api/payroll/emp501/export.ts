/**
 * GET /api/payroll/emp501/export?taxYear=2025
 *
 * Produces e@syFile-style CSV: one row per employee with aggregated tax year totals.
 * Format: employee_name, irp5_number, gross_income, paye, uif, sdl
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

function escapeCsvField(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const taxYear = req.query.taxYear ? Number(req.query.taxYear) : new Date().getFullYear();

  log.info('EMP501 export requested', { companyId, taxYear }, 'emp501Export');

  const rows = (await sql`
    SELECT
      pe.first_name,
      pe.last_name,
      pe.tax_number,
      pe.id_number,
      SUM(prl.gross_pay)                          AS gross_income,
      SUM(prl.paye)                               AS total_paye,
      SUM(prl.uif_employee + prl.uif_employer)    AS total_uif,
      SUM(prl.sdl)                                AS total_sdl
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    JOIN payroll_employees   pe  ON pe.id  = prl.employee_id
    WHERE prh.company_id = ${companyId}::uuid
      AND (
        (prh.period_year = ${taxYear - 1} AND prh.period_month >= 3)
        OR
        (prh.period_year = ${taxYear}     AND prh.period_month <= 2)
      )
    GROUP BY pe.id, pe.first_name, pe.last_name, pe.tax_number, pe.id_number
    ORDER BY pe.last_name, pe.first_name
  `) as Row[];

  const header = 'employee_name,irp5_number,gross_income,paye,uif,sdl';
  const lines = rows.map((r, idx) => {
    const name = `${r.first_name} ${r.last_name}`;
    const irp5Number = r.tax_number ? String(r.tax_number) : `IRP5-${String(idx + 1).padStart(4, '0')}`;
    return [
      escapeCsvField(name),
      escapeCsvField(irp5Number),
      Number(r.gross_income).toFixed(2),
      Number(r.total_paye).toFixed(2),
      Number(r.total_uif).toFixed(2),
      Number(r.total_sdl).toFixed(2),
    ].join(',');
  });

  const csv = [header, ...lines].join('\n');
  const filename = `EMP501_${taxYear - 1}_${taxYear}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(csv);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
