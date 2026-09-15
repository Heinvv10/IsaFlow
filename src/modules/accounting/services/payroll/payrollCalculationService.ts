import { runPayrollCalculation } from './payrollCalculationBoundary';
import { sql, withTransaction, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { listPayrollEmployees, listTaxNumbersForCompany } from './payrollEmployeeService';
import { getEmployeeComponents } from './payrollComponentService';
import { calculatePayrollLine } from './payrollCalculator';
import { applySdlToLines, estimateAnnualRemuneration } from './sdlLeviabilityService';
import { validateEmployee, validateEti, validatePayrollLine } from './validationEngine';
import { getTaxYear } from './taxTables';
import { isPayrollRunLocked, PayrollRunLockedError } from './payrollRunLock';
import type { PayrollPeriod } from './payrollTypes';
import type { ApplyLoanResult } from './payrollLoanService';
import { applyRunLoans } from './payrollRunLoanApplication';
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
  let totalEti = 0;
  let totalNet = 0;

  // Build all line inserts in memory before touching the DB
  type LineInsert = {
    employeeId: string;
    grossPay: number; taxableIncome: number; paye: number;
    uifEmployee: number; uifEmployer: number;
    sdl: number; sdlLeviable: number;
    eti: number; netPay: number;
    componentBreakdown: string; validationResults: string;
  };

  const lineInserts: LineInsert[] = [];

  // Undo the loan deductions THIS run already applied, then re-apply the
  // instalments due — one locked transaction, so a recalculation reproduces
  // the same payslip instead of dropping the deduction while keeping the
  // reduced balance. See payrollRunLoanApplication.ts.
  const loansByEmployee = await applyRunLoans({
    companyId,
    runId,
    periodYear: period.year,
    periodMonth: period.month,
    officialRate: Number(process.env.SARS_OFFICIAL_RATE ?? 0.085),
    journalEntryId: run.journal_entry_id == null ? null : String(run.journal_entry_id),
  });

  for (const employee of employees) {
    const components = await getEmployeeComponents(employee.id, companyId, periodDate);
    const componentsWithTermination = await appendTerminationIfEndingThisPeriod(
      companyId,
      employee,
      components,
      period,
    );

    const loanApplications: ApplyLoanResult[] = loansByEmployee.get(employee.id) ?? [];
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
      annualPayrollEstimate: 'defer',
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
      sdl: 0, // set below, once the run's own leviable total decides leviability
      sdlLeviable: line.sdlLeviable,
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
    totalEti += line.eti.monthlyEti;
    totalNet += line.netPay;
  }

  const r = (n: number) => Math.round(n * 100) / 100;

  // SDL leviability belongs to the employer, not to one employee, and is
  // decided on twelve months of remuneration — see sdlLeviabilityService for
  // the basis. The levy itself is still charged per line on that line's own
  // leviable amount. The previous headcount x R25 000 x 12 decided the
  // threshold by employee count alone, exempting any single employee however
  // much they earned and levying any two however little.
  const annualRemuneration = await estimateAnnualRemuneration(
    companyId, period, r(totalGross), runId,
  );
  const totalSdl = applySdlToLines(lineInserts, annualRemuneration, taxYear);

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
