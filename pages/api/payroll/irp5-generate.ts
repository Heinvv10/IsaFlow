/**
 * IRP5 Certificate Generation API
 * POST: generate IRP5 for an employee or batch
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { buildIRP5Certificate, validateIRP5Data, type IRP5EmployeeData } from '@/modules/accounting/services/irp5Service';

type Row = Record<string, unknown>;

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    // List generated IRP5 certificates
    const { taxYear } = req.query;
    const yr = taxYear ? Number(taxYear) : new Date().getFullYear();
    const rows = await sql`
      SELECT e.id, e.first_name, e.last_name, e.id_number, e.tax_number,
        COALESCE(SUM(ps.gross_pay), 0) as total_gross,
        COALESCE(SUM(ps.paye), 0) as total_paye,
        COALESCE(SUM(ps.uif_employee), 0) as total_uif
      FROM employees e
      LEFT JOIN payslips ps ON ps.employee_id = e.id
      LEFT JOIN payroll_runs pr ON ps.payroll_run_id = pr.id AND EXTRACT(YEAR FROM pr.period_end) = ${yr}
      GROUP BY e.id, e.first_name, e.last_name, e.id_number, e.tax_number
      ORDER BY e.last_name
    ` as Row[];
    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    const { employeeId, taxYear } = req.body;
    if (!employeeId) return apiResponse.badRequest(res, 'employeeId is required');
    const yr = taxYear || new Date().getFullYear();

    // Get employee
    const employees = await sql`SELECT * FROM employees WHERE id = ${employeeId}` as Row[];
    if (!employees[0]) return apiResponse.notFound(res, 'Employee', employeeId);
    const emp = employees[0] as any;

    // Validate
    const validation = validateIRP5Data({
      employeeName: `${emp.first_name} ${emp.last_name}`,
      idNumber: emp.id_number || '',
      taxNumber: emp.tax_number || '',
      grossSalary: 1,
      paye: 1,
    });
    if (!validation.valid) return apiResponse.badRequest(res, 'IRP5 validation failed', validation.errors);

    // Aggregate payslip data for the tax year
    const payslips = await sql`
      SELECT
        COALESCE(SUM(ps.gross_pay), 0) as gross_salary,
        COALESCE(SUM(ps.paye), 0) as paye,
        COALESCE(SUM(ps.uif_employee), 0) as uif_employee,
        COALESCE(SUM(ps.uif_employer), 0) as uif_employer,
        COALESCE(SUM(ps.sdl), 0) as sdl
      FROM payslips ps
      JOIN payroll_runs pr ON ps.payroll_run_id = pr.id
      WHERE ps.employee_id = ${employeeId}
        AND pr.period_end >= ${`${yr - 1}-03-01`}
        AND pr.period_end <= ${`${yr}-02-28`}
    ` as Row[];

    const data = payslips[0] as any || {};
    const employeeData: IRP5EmployeeData = {
      grossSalary: Number(data.gross_salary || 0),
      commission: 0,
      overtime: 0,
      bonus: 0,
      travelAllowance: 0,
      pensionContribEmployee: 0,
      medicalAidEmployee: 0,
      retirementAnnuity: 0,
      paye: Number(data.paye || 0),
      uifEmployee: Number(data.uif_employee || 0),
      uifEmployer: Number(data.uif_employer || 0),
      sdl: Number(data.sdl || 0),
    };

    // Fetch company details for employer info
    const companyRows = await sql`SELECT name, vat_number FROM companies WHERE id = ${req.companyId}` as Row[];
    const company = companyRows[0] as Record<string, string> | undefined;

    const cert = buildIRP5Certificate({
      employeeData,
      employeeName: `${emp.first_name} ${emp.last_name}`,
      idNumber: emp.id_number || '',
      taxNumber: emp.tax_number || '',
      employerName: String(company?.name || 'Unknown Company'),
      employerPayeRef: String(company?.vat_number || ''),
      taxYear: yr,
      periodStart: `${yr - 1}-03-01`,
      periodEnd: `${yr}-02-28`,
    });

    log.info('IRP5 generated', { employeeId, taxYear: yr }, 'payroll');
    return apiResponse.success(res, cert);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as any));
