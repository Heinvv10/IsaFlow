/**
 * GET /api/payroll/irp5/summary?taxYear=2025
 *
 * Tax year = year ending Feb: 2025 means Mar 2024 – Feb 2025.
 * Returns per-employee aggregates from payroll runs plus SARS compliance
 * messages produced by the IRP5 validation engine.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  validateCompanyComponents,
  validateEmployeeIrp5,
  highestSeverity,
  type ComponentConfig,
  type ValidationMessage,
  type ValidationSeverity,
} from '@/modules/accounting/services/payroll/irp5ValidationEngine';

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
  messages: ValidationMessage[];
}

function taxYearRange(taxYear: number): { startMonth: number; startYear: number; endMonth: number; endYear: number } {
  return { startMonth: 3, startYear: taxYear - 1, endMonth: 2, endYear: taxYear };
}

function deriveStatus(
  messages: ValidationMessage[],
  totalGross: number,
): Irp5EmployeeRow['status'] {
  if (totalGross === 0) return 'missing';
  const sev: ValidationSeverity | null = highestSeverity(messages);
  if (sev === 'error' || sev === 'warning') return 'incomplete';
  return 'ready';
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  // Pentest M17: bound numeric query params.
  const taxYearRaw = req.query.taxYear ? Number(req.query.taxYear) : new Date().getFullYear();
  if (!Number.isInteger(taxYearRaw) || taxYearRaw < 2000 || taxYearRaw > 2100) {
    return apiResponse.badRequest(res, 'taxYear must be an integer between 2000 and 2100');
  }
  const taxYear = taxYearRaw;

  const { startMonth, startYear, endMonth, endYear } = taxYearRange(taxYear);

  // Employees, payroll aggregates, both component lookups, and severance-
  // directive presence all fan out in parallel.
  const [empRows, aggRows, companyCompRows, empCompRows, directiveRows] = await Promise.all([
    sql`
      SELECT id, first_name, last_name, id_number, tax_number, start_date, end_date
      FROM   payroll_employees
      WHERE  company_id = ${companyId}::uuid
      ORDER  BY last_name, first_name
    ` as Promise<Row[]>,

    sql`
      SELECT
        prl.employee_id,
        SUM(prl.gross_pay)                       AS total_gross,
        SUM(prl.taxable_income)                  AS total_taxable,
        SUM(prl.paye)                            AS total_paye,
        SUM(prl.uif_employee + prl.uif_employer) AS total_uif,
        SUM(prl.sdl)                             AS total_sdl
      FROM payroll_run_lines prl
      JOIN payroll_run_headers prh ON prh.id = prl.run_id
      WHERE prh.company_id = ${companyId}::uuid
        AND (
          (prh.period_year = ${startYear} AND prh.period_month >= ${startMonth})
          OR
          (prh.period_year = ${endYear}   AND prh.period_month <= ${endMonth})
        )
      GROUP BY prl.employee_id
    ` as Promise<Row[]>,

    sql`
      SELECT id, name, sars_source_code, component_type, is_active
      FROM   payroll_components
      WHERE  company_id = ${companyId}::uuid
    ` as Promise<Row[]>,

    sql`
      SELECT DISTINCT pec.employee_id, pc.sars_source_code
      FROM   payroll_employee_components pec
      JOIN   payroll_components pc ON pc.id = pec.component_id
      JOIN   payroll_employees  pe ON pe.id = pec.employee_id
      WHERE  pe.company_id = ${companyId}::uuid
        AND  pc.is_active = TRUE
        AND  (pec.effective_to IS NULL OR pec.effective_to >= CURRENT_DATE)
    ` as Promise<Row[]>,

    sql`
      SELECT DISTINCT employee_id
      FROM   tax_directives
      WHERE  company_id     = ${companyId}::uuid
        AND  directive_type = 'severance'
        AND  status         = 'approved'
        AND  effective_date <= ${`${endYear}-02-28`}::date
        AND  (expiry_date IS NULL OR expiry_date >= ${`${startYear}-03-01`}::date)
    ` as Promise<Row[]>,
  ]);

  const employeesWithSeveranceDirective = new Set(
    directiveRows.map((r) => String(r.employee_id)),
  );

  const aggMap = new Map<string, Row>();
  aggRows.forEach((r) => aggMap.set(String(r.employee_id), r));

  const codesByEmployee = new Map<string, string[]>();
  for (const r of empCompRows) {
    const eid = String(r.employee_id);
    const list = codesByEmployee.get(eid) ?? [];
    list.push(String(r.sars_source_code));
    codesByEmployee.set(eid, list);
  }

  const components: ComponentConfig[] = companyCompRows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    sarsSourceCode: String(r.sars_source_code),
    componentType: String(r.component_type) as ComponentConfig['componentType'],
    isActive: Boolean(r.is_active),
  }));
  const componentIssues = await validateCompanyComponents(components, taxYear);

  const employees: Irp5EmployeeRow[] = await Promise.all(empRows.map(async (emp) => {
    const agg = aggMap.get(String(emp.id));
    const totalGross = agg ? Number(agg.total_gross) : 0;
    const totalPaye = agg ? Number(agg.total_paye) : 0;
    const totalUif = agg ? Number(agg.total_uif) : 0;
    const totalSdl = agg ? Number(agg.total_sdl) : 0;

    const messages = await validateEmployeeIrp5({
      taxNumber: emp.tax_number ? String(emp.tax_number) : null,
      idNumber: emp.id_number ? String(emp.id_number) : null,
      totalGross,
      totalPaye,
      totalUif,
      totalSdl,
      componentCodes: codesByEmployee.get(String(emp.id)) ?? [],
      hasApprovedSeveranceDirective: employeesWithSeveranceDirective.has(String(emp.id)),
    }, taxYear);

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
      totalPaye,
      totalUif,
      totalSdl,
      status: deriveStatus(messages, totalGross),
      messages,
    };
  }));

  const summary = {
    taxYear,
    totalEmployees: employees.length,
    certificatesReady: employees.filter((e) => e.status === 'ready').length,
    incomplete: employees.filter((e) => e.status === 'incomplete').length,
    missing: employees.filter((e) => e.status === 'missing').length,
    totalPayeSubmitted: employees.reduce((s, e) => s + e.totalPaye, 0),
    componentIssues,
    employees,
  };

  return apiResponse.success(res, summary);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
