import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { listPayrollEmployees, listTaxNumbersForCompany } from './payrollEmployeeService';
import { getEmployeeComponents } from './payrollComponentService';
import { calculatePayrollLine } from './payrollCalculator';
import { validateEmployee, validateEti, validatePayrollLine } from './validationEngine';
import { getTaxYear } from './taxTables';
import { isPayrollRunLocked, PayrollRunLockedError } from './payrollRunLock';
import type { EmployeeComponent, PayrollComponent, PayrollPeriod, ValidationResult } from './payrollTypes';
import {
  buildTerminationComponents,
  getTerminationDetails,
  getAnnualLeaveBalance,
  yearsOfService,
  type TerminationReason,
} from './payrollTerminationService';
import type { ApplyLoanResult } from './payrollLoanService';
import { applyRunLoans } from './payrollRunLoanApplication';


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

export function mapRunRow(r: Row): PayrollRunSummary {
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

export class PayrollRunDuplicateError extends Error {
  readonly month: number;
  readonly year: number;
  constructor(month: number, year: number) {
    super(`A payroll run for ${month}/${year} already exists.`);
    this.name = 'PayrollRunDuplicateError';
    this.month = month;
    this.year = year;
  }
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
    throw new PayrollRunDuplicateError(period.month, period.year);
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

  // All DB mutations in one transaction so a partial failure cannot corrupt
  // state — but via `withTransaction`, NEVER raw BEGIN/COMMIT.
  //
  // This used to issue `sql`BEGIN``/`sql`COMMIT`` directly. Those route onto
  // the ALS request client (`neon.ts` LazyQuery.run), which is the transaction
  // `withAuth` opens for every request — so the COMMIT committed the WHOLE
  // request, not this block: every earlier write in the request was made
  // durable, and any enclosing savepoint ceased to exist. On the MCP path that
  // destroyed the registry's per-tool savepoint, so a later failure could not
  // roll this back and the RELEASE SAVEPOINT afterwards errored into a generic
  // failure over lines that were already committed.
  //
  // `withTransaction` nests a SAVEPOINT when a request transaction is in
  // flight and opens a real transaction only when there is none, which is
  // correct under both callers.
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
    { runId, employeeCount: employees.length, totalGross },
    'payrollRunService',
  );
  return mapRunRow(updated[0]);
}

export interface PayrollRunLine {
  id: string;
  runId: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  grossPay: number;
  taxableIncome: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
  netPay: number;
  /**
   * Warnings raised while calculating this line. Written since the run service
   * was built, but dropped by this mapper until the ETI work — so every warning
   * the validation engine produced was invisible to every caller.
   */
  validationResults: ValidationResult[];
}

/**
 * Read `payroll_run_lines.validation_results` defensively.
 *
 * pg hands back parsed jsonb, but a text column or a driver change would give a
 * string. A malformed value must degrade to "no warnings" rather than throw —
 * a broken warning payload may not take down the run detail page.
 */
function parseValidationResults(raw: unknown): ValidationResult[] {
  const value = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  return Array.isArray(value) ? (value as ValidationResult[]) : [];
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Append synthetic termination components (leave pay-out, notice pay,
 * severance) when the employee's end_date falls within this payroll period
 * and a termination reason is captured on their profile. Silent no-op
 * otherwise so non-terminating employees are unaffected.
 */
async function appendTerminationIfEndingThisPeriod(
  companyId: string,
  employee: { id: string; endDate?: Date; startDate: Date },
  components: EmployeeComponent[],
  period: PayrollPeriod,
): Promise<EmployeeComponent[]> {
  const { endDate, startDate } = employee;
  if (!endDate) return components;
  const endYear = endDate.getFullYear();
  const endMonth = endDate.getMonth() + 1;
  if (endYear !== period.year || endMonth !== period.month) return components;

  const details = await getTerminationDetails(companyId, employee.id);
  if (!details || !details.reason) return components;

  const monthlySalary = components
    .filter((c) => c.component.componentType === 'earning')
    .reduce((sum, c) => sum + c.amount, 0);
  if (monthlySalary <= 0) return components;

  const unusedLeaveDays = details.includeLeavePayout
    ? await getAnnualLeaveBalance(companyId, employee.id, period.year)
    : 0;

  const termination = buildTerminationComponents({
    monthlySalary,
    unusedLeaveDays,
    noticePeriodDays: details.noticePeriodDays ?? 0,
    servedNoticeDays: details.servedNoticeDays ?? 0,
    severanceWeeksPerYear: details.severanceWeeksPerYear ?? 0,
    yearsOfService: yearsOfService(
      startDate.toISOString().slice(0, 10),
      endDate.toISOString().slice(0, 10),
    ),
    includeLeavePayout: details.includeLeavePayout,
    reason: details.reason as TerminationReason,
  });

  if (termination.length > 0) {
    log.info('Termination components injected into payroll run', {
      companyId, employeeId: employee.id, period, count: termination.length,
    }, 'payrollRunService');
  }
  return [...components, ...termination];
}

/**
 * Resolves the SARS-coded payroll components used to represent loan impact
 * on a payslip:
 *   - code 'LOAN'  : earner-facing deduction for principal + interest.
 *   - code '3801'  : taxable fringe benefit (low-interest loan).
 * Callers pre-seed these components under Setup → Pay Components. Loans
 * silently skip the row if the component doesn't exist (the payment is
 * still recorded on payroll_loan_payments, just not shown on payslip
 * until the admin adds the component).
 */
async function loadLoanComponents(companyId: string): Promise<{
  deduction: PayrollComponent | null;
  fringe: PayrollComponent | null;
}> {
  const rows = (await sql`
    SELECT id, name, sars_source_code, component_type,
           is_taxable, is_uif_applicable, is_sdl_applicable
      FROM payroll_components
     WHERE company_id = ${companyId}::uuid
       AND is_active = true
       AND sars_source_code IN ('LOAN', '3801')
  `) as Row[];

  let deduction: PayrollComponent | null = null;
  let fringe: PayrollComponent | null = null;
  for (const r of rows) {
    const component: PayrollComponent = {
      id: String(r.id),
      name: String(r.name),
      sarsSourceCode: String(r.sars_source_code),
      componentType: r.component_type as PayrollComponent['componentType'],
      isTaxable: r.is_taxable === true,
      isUifApplicable: r.is_uif_applicable === true,
      isSdlApplicable: r.is_sdl_applicable === true,
    };
    if (component.sarsSourceCode === 'LOAN') deduction = component;
    if (component.sarsSourceCode === '3801') fringe = component;
  }
  return { deduction, fringe };
}

async function appendLoanComponents(
  companyId: string,
  components: EmployeeComponent[],
  loanApplications: ApplyLoanResult[],
): Promise<EmployeeComponent[]> {
  if (loanApplications.length === 0) return components;

  const { deduction, fringe } = await loadLoanComponents(companyId);
  const injected: EmployeeComponent[] = [];

  for (const app of loanApplications) {
    const repayment = app.interest + app.principal;
    if (repayment > 0 && deduction) {
      injected.push({ component: deduction, amount: repayment });
    }
    if (app.fringeBenefit > 0 && fringe) {
      injected.push({ component: fringe, amount: app.fringeBenefit });
    }
  }

  if (injected.length > 0) {
    log.info('Loan components injected into payroll run', {
      companyId, count: injected.length,
    }, 'payrollRunService');
  }

  return [...components, ...injected];
}

export async function getPayrollRunLines(
  runId: string,
  companyId: string,
): Promise<PayrollRunLine[]> {
  const rows = (await sql`
    SELECT
      prl.*,
      pe.employee_number,
      pe.first_name,
      pe.last_name
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    JOIN payroll_employees    pe  ON pe.id  = prl.employee_id
    WHERE prl.run_id = ${runId}::uuid
      AND prh.company_id = ${companyId}::uuid
    ORDER BY pe.employee_number
  `) as Row[];

  return rows.map(r => ({
    id: String(r.id),
    runId: String(r.run_id),
    employeeId: String(r.employee_id),
    employeeNumber: String(r.employee_number),
    employeeName: `${r.first_name} ${r.last_name}`,
    grossPay: Number(r.gross_pay),
    taxableIncome: Number(r.taxable_income),
    paye: Number(r.paye),
    uifEmployee: Number(r.uif_employee),
    uifEmployer: Number(r.uif_employer),
    sdl: Number(r.sdl),
    eti: Number(r.eti),
    netPay: Number(r.net_pay),
    validationResults: parseValidationResults(r.validation_results),
  }));
}
