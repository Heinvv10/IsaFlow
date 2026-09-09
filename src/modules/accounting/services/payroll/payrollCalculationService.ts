import { runPayrollCalculation } from './payrollCalculationBoundary';
import { sql, withTransaction, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { listPayrollEmployees, listTaxNumbersForCompany } from './payrollEmployeeService';
import { getEmployeeComponents } from './payrollComponentService';
import { calculatePayrollLine } from './payrollCalculator';
import { validateEmployee, validateEti, validatePayrollLine } from './validationEngine';
import { getTaxYear } from './taxTables';
import { isPayrollRunLocked, PayrollRunLockedError } from './payrollRunLock';
import type { PayrollPeriod } from './payrollTypes';
import { applyLoanToRun, listActiveLoansForRun, type ApplyLoanResult } from './payrollLoanService';
import { appendTerminationIfEndingThisPeriod, appendLoanComponents } from './payrollCalculationComponents';
import { mapRunRow, type PayrollRunSummary } from './payrollRunService';
type Row = DbRow;
async function calculatePayrollRunEffect(
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
  if (isPayrollRunLocked(String(run.status))) {
    throw new PayrollRunLockedError(String(run.status));
  }
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

  // Build all line inserts in memory before touching the DB
  type LineInsert = {
    employeeId: string;
    grossPay: number; taxableIncome: number; paye: number;
    uifEmployee: number; uifEmployer: number; sdl: number;
    eti: number; netPay: number;
    componentBreakdown: string; validationResults: string;
  };

  const lineInserts: LineInsert[] = [];

  const activeLoans = await listActiveLoansForRun(companyId, period.year, period.month);
  const loansByEmployee = new Map<string, string[]>();
  for (const row of activeLoans) {
    const list = loansByEmployee.get(row.employeeId) ?? [];
    list.push(row.loanId);
    loansByEmployee.set(row.employeeId, list);
  }
  const officialRate = Number(process.env.SARS_OFFICIAL_RATE ?? 0.085);

  for (const employee of employees) {
    const components = await getEmployeeComponents(employee.id, companyId, periodDate);
    const componentsWithTermination = await appendTerminationIfEndingThisPeriod(
      companyId,
      employee,
      components,
      period,
    );

    const loanIds = loansByEmployee.get(employee.id) ?? [];
    const loanApplications: ApplyLoanResult[] = [];
    for (const loanId of loanIds) {
      const applied = await applyLoanToRun({
        loanId,
        companyId,
        runId,
        periodYear: period.year,
        periodMonth: period.month,
        officialRate,
      });
      if (applied) loanApplications.push(applied);
    }
    const componentsWithLoans = await appendLoanComponents(
      companyId,
      componentsWithTermination,
      loanApplications,
    );

    const line = calculatePayrollLine({
      employee,
      components: componentsWithLoans,
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

    lineInserts.push({
      employeeId: employee.id,
      grossPay: line.grossPay,
      taxableIncome: line.taxableIncome,
      paye: line.paye.monthlyPaye,
      uifEmployee: line.uif.employeeContribution,
      uifEmployer: line.uif.employerContribution,
      sdl: line.sdl,
      eti: line.eti.monthlyEti,
      netPay: line.netPay,
      componentBreakdown: JSON.stringify(line.componentBreakdown),
      validationResults: JSON.stringify([
        ...empValidation, ...lineValidation, ...validateEti(employee, line.eti),
      ]),
    });

    totalGross += line.grossPay;
    totalPaye += line.paye.monthlyPaye;
    totalUifEmployee += line.uif.employeeContribution;
    totalUifEmployer += line.uif.employerContribution;
    totalSdl += line.sdl;
    totalEti += line.eti.monthlyEti;
    totalNet += line.netPay;
  }

  const r = (n: number) => Math.round(n * 100) / 100;

  // The authenticated calculation boundary owns the complete transaction/savepoint.
  await withTransaction(async (tx) => {
    await tx`DELETE FROM payroll_run_lines WHERE run_id = ${runId}::uuid AND run_id IN (
      SELECT id FROM payroll_run_headers WHERE company_id = ${companyId}::uuid
    )`;

    for (const ins of lineInserts) {
      await tx`
        INSERT INTO payroll_run_lines (
          run_id, employee_id, gross_pay, taxable_income, paye,
          uif_employee, uif_employer, sdl, eti, net_pay,
          component_breakdown, validation_results
        ) VALUES (
          ${runId}::uuid, ${ins.employeeId}::uuid,
          ${ins.grossPay}, ${ins.taxableIncome}, ${ins.paye},
          ${ins.uifEmployee}, ${ins.uifEmployer},
          ${ins.sdl}, ${ins.eti}, ${ins.netPay},
          ${ins.componentBreakdown},
          ${ins.validationResults}
        )
      `;
    }
  });

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
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
    RETURNING *
  `) as Row[];

  if (!updated[0]) throw new Error('UPDATE returned no row');

  log.info(
    'Payroll run calculated',
    { runId, employeeCount: employees.length },
    'payrollRunService',
  );
  return mapRunRow(updated[0]);
}


export async function calculatePayrollRun(runId:string,companyId:string):Promise<PayrollRunSummary> {
  return runPayrollCalculation(runId,companyId,()=>calculatePayrollRunEffect(runId,companyId));
}
