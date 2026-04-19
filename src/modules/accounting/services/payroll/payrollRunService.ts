import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { listPayrollEmployees, listTaxNumbersForCompany } from './payrollEmployeeService';
import { getEmployeeComponents } from './payrollComponentService';
import { calculatePayrollLine } from './payrollCalculator';
import { validateEmployee, validatePayrollLine } from './validationEngine';
import { getTaxYear } from './taxTables';
import type { PayrollPeriod } from './payrollTypes';

type Row = DbRow;

export interface PayrollRunSummary {
  id: string;
  companyId: string;
  periodMonth: number;
  periodYear: number;
  status: string;
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  totalEti: number;
  totalNet: number;
  employeeCount: number;
}

function mapRunRow(r: Row): PayrollRunSummary {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    periodMonth: Number(r.period_month),
    periodYear: Number(r.period_year),
    status: String(r.status),
    totalGross: Number(r.total_gross) || 0,
    totalPaye: Number(r.total_paye) || 0,
    totalUif: Number(r.total_uif) || 0,
    totalSdl: Number(r.total_sdl) || 0,
    totalEti: Number(r.total_eti) || 0,
    totalNet: Number(r.total_net) || 0,
    employeeCount: Number(r.employee_count) || 0,
  };
}

export async function listPayrollRuns(companyId: string): Promise<PayrollRunSummary[]> {
  const rows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE company_id = ${companyId}::uuid
    ORDER BY period_year DESC, period_month DESC
  `) as Row[];
  return rows.map(mapRunRow);
}

export async function createPayrollRun(
  companyId: string,
  period: PayrollPeriod,
  createdBy?: string,
): Promise<PayrollRunSummary> {
  log.info('Creating payroll run', { companyId, period }, 'payrollRunService');
  const rows = (await sql`
    INSERT INTO payroll_run_headers (company_id, period_month, period_year, created_by)
    VALUES (${companyId}::uuid, ${period.month}, ${period.year}, ${createdBy ?? null}::uuid)
    ON CONFLICT (company_id, period_year, period_month) DO NOTHING
    RETURNING *
  `) as Row[];
  if (rows.length === 0) {
    throw new Error(`Payroll run for ${period.month}/${period.year} already exists`);
  }
  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapRunRow(rows[0]);
}

export async function getPayrollRun(
  id: string,
  companyId: string,
): Promise<PayrollRunSummary | null> {
  const rows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  return rows.length > 0 && rows[0] ? mapRunRow(rows[0]) : null;
}

export async function calculatePayrollRun(
  runId: string,
  companyId: string,
): Promise<PayrollRunSummary> {
  log.info('Calculating payroll run', { runId, companyId }, 'payrollRunService');

  const runRows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (runRows.length === 0 || !runRows[0]) throw new Error('Payroll run not found');

  const run = runRows[0];
  const period: PayrollPeriod = {
    month: Number(run.period_month),
    year: Number(run.period_year),
  };
  const taxYear = getTaxYear(period.month, period.year);
  const periodDate = new Date(period.year, period.month - 1, 28);

  const employees = await listPayrollEmployees(companyId);
  const allTaxNumbers = await listTaxNumbersForCompany(companyId);

  let totalGross = 0;
  let totalPaye = 0;
  let totalUifEmployee = 0;
  let totalUifEmployer = 0;
  let totalSdl = 0;
  let totalEti = 0;
  let totalNet = 0;

  const annualPayrollEstimate = employees.length * 25_000 * 12;

  await sql`DELETE FROM payroll_run_lines WHERE run_id = ${runId}::uuid`;

  for (const employee of employees) {
    const components = await getEmployeeComponents(employee.id, periodDate);
    const line = calculatePayrollLine({
      employee,
      components,
      period,
      taxYear,
      annualPayrollEstimate,
    });

    const otherTaxNumbers = allTaxNumbers.filter(t => t !== employee.taxNumber);
    const empValidation = validateEmployee(employee, otherTaxNumbers);
    const lineValidation = validatePayrollLine({
      taxableIncome: line.taxableIncome,
      monthlyPaye: line.paye.monthlyPaye,
      grossPay: line.grossPay,
    });

    await sql`
      INSERT INTO payroll_run_lines (
        run_id, employee_id, gross_pay, taxable_income, paye,
        uif_employee, uif_employer, sdl, eti, net_pay,
        component_breakdown, validation_results
      ) VALUES (
        ${runId}::uuid, ${employee.id}::uuid,
        ${line.grossPay}, ${line.taxableIncome}, ${line.paye.monthlyPaye},
        ${line.uif.employeeContribution}, ${line.uif.employerContribution},
        ${line.sdl}, ${line.eti.monthlyEti}, ${line.netPay},
        ${JSON.stringify(line.componentBreakdown)},
        ${JSON.stringify([...empValidation, ...lineValidation])}
      )
    `;

    totalGross += line.grossPay;
    totalPaye += line.paye.monthlyPaye;
    totalUifEmployee += line.uif.employeeContribution;
    totalUifEmployer += line.uif.employerContribution;
    totalSdl += line.sdl;
    totalEti += line.eti.monthlyEti;
    totalNet += line.netPay;
  }

  const r = (n: number) => Math.round(n * 100) / 100;

  const updated = (await sql`
    UPDATE payroll_run_headers SET
      status         = 'calculated',
      total_gross    = ${r(totalGross)},
      total_taxable  = ${r(totalGross)},
      total_paye     = ${r(totalPaye)},
      total_uif      = ${r(totalUifEmployee + totalUifEmployer)},
      total_sdl      = ${r(totalSdl)},
      total_eti      = ${r(totalEti)},
      total_net      = ${r(totalNet)},
      employee_count = ${employees.length},
      updated_at     = NOW()
    WHERE id = ${runId}::uuid
    RETURNING *
  `) as Row[];

  if (!updated[0]) throw new Error('UPDATE returned no row');

  log.info(
    'Payroll run calculated',
    { runId, employeeCount: employees.length, totalGross },
    'payrollRunService',
  );
  return mapRunRow(updated[0]);
}
