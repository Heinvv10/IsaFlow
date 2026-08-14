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
import { escapeCsv } from '@/lib/csv';

type Row = DbRow;

/** Build the e@syFile-style CSV. Exported for unit testing (formula-injection safety). */
export function buildEmp501Csv(rows: Row[]): string {
  const header = 'employee_name,irp5_number,gross_income,paye,uif,sdl';
  const lines = rows.map((r, idx) => {
    const name = `${r.first_name} ${r.last_name}`;
    const irp5Number = r.tax_number ? String(r.tax_number) : `IRP5-${String(idx + 1).padStart(4, '0')}`;
    return [
      escapeCsv(name),
      escapeCsv(irp5Number),
      Number(r.gross_income).toFixed(2),
      Number(r.total_paye).toFixed(2),
      Number(r.total_uif).toFixed(2),
      Number(r.total_sdl).toFixed(2),
    ].join(',');
  });
  return [header, ...lines].join('\n');
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  // Pentest M17: bound numeric query params — reject year 9999 / -1 / NaN.
  const taxYearRaw = req.query.taxYear ? Number(req.query.taxYear) : new Date().getFullYear();
  if (!Number.isInteger(taxYearRaw) || taxYearRaw < 2000 || taxYearRaw > 2100) {
    return apiResponse.badRequest(res, 'taxYear must be an integer between 2000 and 2100');
  }
  const taxYear = taxYearRaw;

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

  const csv = buildEmp501Csv(rows);
  const filename = `EMP501_${taxYear - 1}_${taxYear}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(csv);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
