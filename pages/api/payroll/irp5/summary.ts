/**
 * GET /api/payroll/irp5/summary?taxYear=2025
 *
 * Tax year = year ending Feb: 2025 means Mar 2024 – Feb 2025.
 * Returns per-employee aggregates from payroll runs.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

export interface Irp5EmployeeRow {
  employeeId: string;
  firstName: string;
  lastName: string;
  idNumber: string | null;
  taxNumber: string | null;
  startDate: string;
  endDate: string | null;
  totalGross: number;
  totalTaxable: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  status: 'ready' | 'incomplete' | 'missing';
  flags: string[];
}

function taxYearRange(taxYear: number): { startMonth: number; startYear: number; endMonth: number; endYear: number } {
  // Tax year ending Feb taxYear: Mar (taxYear-1) to Feb (taxYear)
  return { startMonth: 3, startYear: taxYear - 1, endMonth: 2, endYear: taxYear };
}

function employeeStatus(row: Row, totalGross: number): { status: Irp5EmployeeRow['status']; flags: string[] } {
  const flags: string[] = [];
  if (!row.tax_number) flags.push('Missing tax number');
  if (!row.id_number) flags.push('Missing ID/passport number');
  if (totalGross === 0) flags.push('No payroll runs in period');

  if (flags.includes('No payroll runs in period')) return { status: 'missing', flags };
  if (flags.length > 0) return { status: 'incomplete', flags };
  return { status: 'ready', flags };
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const taxYear = req.query.taxYear ? Number(req.query.taxYear) : new Date().getFullYear();

  const { startMonth, startYear, endMonth, endYear } = taxYearRange(taxYear);

  // All employees for this company
  const empRows = (await sql`
    SELECT id, first_name, last_name, id_number, tax_number, start_date, end_date
    FROM   payroll_employees
    WHERE  company_id = ${companyId}::uuid
    ORDER  BY last_name, first_name
  `) as Row[];

  // Aggregate payroll run lines for the tax year period
  const aggRows = (await sql`
    SELECT
      prl.employee_id,
      SUM(prl.gross_pay)     AS total_gross,
      SUM(prl.taxable_income)AS total_taxable,
      SUM(prl.paye)          AS total_paye,
      SUM(prl.uif_employee + prl.uif_employer) AS total_uif,
      SUM(prl.sdl)           AS total_sdl
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    WHERE prh.company_id = ${companyId}::uuid
      AND (
        (prh.period_year = ${startYear} AND prh.period_month >= ${startMonth})
        OR
        (prh.period_year = ${endYear}   AND prh.period_month <= ${endMonth})
      )
    GROUP BY prl.employee_id
  `) as Row[];

  const aggMap = new Map<string, Row>();
  aggRows.forEach(r => aggMap.set(String(r.employee_id), r));

  const employees: Irp5EmployeeRow[] = empRows.map(emp => {
    const agg = aggMap.get(String(emp.id));
    const totalGross = agg ? Number(agg.total_gross) : 0;
    const { status, flags } = employeeStatus(emp, totalGross);
    return {
      employeeId: String(emp.id),
      firstName: String(emp.first_name),
      lastName: String(emp.last_name),
      idNumber: emp.id_number ? String(emp.id_number) : null,
      taxNumber: emp.tax_number ? String(emp.tax_number) : null,
      startDate: emp.start_date instanceof Date ? emp.start_date.toISOString().slice(0, 10) : String(emp.start_date),
      endDate: emp.end_date
        ? (emp.end_date instanceof Date ? emp.end_date.toISOString().slice(0, 10) : String(emp.end_date))
        : null,
      totalGross,
      totalTaxable: agg ? Number(agg.total_taxable) : 0,
      totalPaye: agg ? Number(agg.total_paye) : 0,
      totalUif: agg ? Number(agg.total_uif) : 0,
      totalSdl: agg ? Number(agg.total_sdl) : 0,
      status,
      flags,
    };
  });

  const summary = {
    taxYear,
    totalEmployees: employees.length,
    certificatesReady: employees.filter(e => e.status === 'ready').length,
    incomplete: employees.filter(e => e.status === 'incomplete').length,
    missing: employees.filter(e => e.status === 'missing').length,
    totalPayeSubmitted: employees.reduce((s, e) => s + e.totalPaye, 0),
    employees,
  };

  return apiResponse.success(res, summary);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
