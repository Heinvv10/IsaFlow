import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { listPayrollRunEmployees, listTaxNumbersForCompany } from './payrollEmployeeService';
import { getEmployeeComponents } from './payrollComponentService';
import { calculatePayrollLine } from './payrollCalculator';
import { applySdlToLines, estimateAnnualRemuneration } from './sdlLeviabilityService';
import { validateEmployee, validateEti, validatePayrollLine } from './validationEngine';
import { getTaxYear, getTaxYearConfig } from './taxTables';
import {
  isPayrollRunLocked, lockCompanyPayrollApprovals, lockPayrollRunHeader, PayrollRunLockedError, saveCalculatedRunTotals,
} from './payrollRunLock';
import { journalInForceOrNull } from './payrollJournalChain';
import type { EmployeeComponent, PayrollEmployee, PayrollPeriod, ValidationResult } from './payrollTypes';
import type { ApplyLoanResult } from './payrollLoanService';
import { applyRunLoans } from './payrollRunLoanApplication';
import { appendLoanComponents } from './payrollRunLoanComponents';
import { appendTerminationIfEndingThisPeriod, severanceOnlyComponents } from './payrollRunTermination';
import { listSeveranceOnlyRunEmployees } from './payrollSeveranceDirective';
import { replaceRunLines, type LineInsert } from './payrollRunLineWriter';
import { laterPeriodsWarnings, loadPayeYearToDate } from './payrollYearToDate';

export { getPayrollRunLines, type PayrollRunLine } from './payrollRunLines';

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
  /** The GL entry posted at approval, still set after reopenPayrollRun. */
  journalEntryId: string | null;
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
    journalEntryId: r.journal_entry_id == null ? null : String(r.journal_entry_id),
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

  // Locked for the whole calculation, with a bounded wait: see lockPayrollRunHeader.
  // The company approval lock first, in approval's order (PAYE 4a follow-ups G4): a calculation then
  // never reads its year-to-date and later-month warnings while an approval is in flight.
  await lockCompanyPayrollApprovals(runId, companyId);
  const run = await lockPayrollRunHeader(runId, companyId);
  if (!run) throw new Error('Payroll run not found');

  if (isPayrollRunLocked(String(run.status))) {
    throw new PayrollRunLockedError(String(run.status));
  }
  const period: PayrollPeriod = {
    month: Number(run.period_month),
    year: Number(run.period_year),
  };
  const taxYear = getTaxYear(period.month, period.year);
  // Refuse an unloaded tax year here, before applyRunLoans commits loan
  // deductions and before any line is built. UnsupportedTaxYearError is a
  // refusal with nothing written; the callers answer it as a 4xx.
  getTaxYearConfig(taxYear);
  const periodDate = new Date(period.year, period.month - 1, 28);

  const employees = await listPayrollRunEmployees(companyId, period);
  const allTaxNumbers = await listTaxNumbersForCompany(companyId);

  let totalGross = 0;
  let totalPaye = 0;
  let totalUifEmployee = 0;
  let totalUifEmployer = 0;
  let totalEti = 0;
  let totalNet = 0;

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
    // Only a journal whose amounts are in the ledger blocks loan work (round 5).
    journalEntryId: await journalInForceOrNull(companyId, run.journal_entry_id),
    // Only the run's own employees: an instalment taken from someone with no
    // line here would reduce the loan with no deduction on any payslip.
    employeeIds: new Set(employees.map(e => e.id)),
  });

  // Leavers from earlier periods whose severance directive this run may pay:
  // the severance line alone, no salary, recurring components or loans, and so
  // no UIF or SDL (audit 2026-10-18 P3, payrollSeveranceDirective.ts).
  const severanceOnly = await listSeveranceOnlyRunEmployees(companyId, runId, period);
  const population: Array<{ employee: PayrollEmployee; severanceOnly: boolean }> = [
    ...employees.map(employee => ({ employee, severanceOnly: false })),
    ...severanceOnly.map(employee => ({ employee, severanceOnly: true })),
  ];
  // Earlier periods of the tax year, for the cumulative PAYE (PAYE 4a follow-ups G4).
  const ytdByEmployee = await loadPayeYearToDate(companyId, runId, period, population.map(p => p.employee.id));
  const laterApproved = await laterPeriodsWarnings(companyId, runId, period);

  for (const { employee, severanceOnly: onlySeverance } of population) {
    const terminationWarnings: ValidationResult[] = [];
    let componentsWithLoans: EmployeeComponent[];
    if (onlySeverance) {
      componentsWithLoans = await severanceOnlyComponents(companyId, runId, employee, period, terminationWarnings);
      if (componentsWithLoans.length === 0) continue;
    } else {
      const components = await getEmployeeComponents(employee.id, companyId, periodDate);
      const componentsWithTermination = await appendTerminationIfEndingThisPeriod(
        companyId, runId, employee, components, period, terminationWarnings,
      );
      const loanApplications: ApplyLoanResult[] = loansByEmployee.get(employee.id) ?? [];
      componentsWithLoans = await appendLoanComponents(companyId, componentsWithTermination, loanApplications);
    }

    const line = calculatePayrollLine({
      employee,
      components: componentsWithLoans,
      period,
      taxYear,
      annualPayrollEstimate: 'defer',
      ytd: ytdByEmployee.get(employee.id),
      notEmployedInPeriod: onlySeverance,
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
      periodicTaxable: line.periodicTaxable,
      annualTaxable: line.annualTaxable,
      paye: line.paye.monthlyPaye,
      medicalCredit: line.medicalCredit,
      medicalSchemeFees: line.medicalSchemeFees,
      uifEmployee: line.uif.employeeContribution,
      uifEmployer: line.uif.employerContribution,
      sdl: 0, // set below, once the run's own leviable total decides leviability
      sdlLeviable: line.sdlLeviable,
      eti: line.eti.monthlyEti,
      netPay: line.netPay,
      componentBreakdown: JSON.stringify(line.componentBreakdown),
      validationResults: JSON.stringify([
        ...empValidation, ...lineValidation, ...validateEti(employee, line.eti, periodDate),
        ...line.validationResults, ...terminationWarnings,
        // Only a line taxed from the tables feeds the later months' cumulative PAYE.
        ...((line.periodicTaxable > 0 || line.annualTaxable > 0) && laterApproved.has(employee.id) ? [laterApproved.get(employee.id)!] : []),
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

  await replaceRunLines(runId, companyId, lineInserts);

  const updated = await saveCalculatedRunTotals(runId, companyId, {
    gross: r(totalGross), paye: r(totalPaye), uif: r(totalUifEmployee + totalUifEmployer),
    sdl: r(totalSdl), eti: r(totalEti), net: r(totalNet), employeeCount: lineInserts.length,
  });

  log.info(
    'Payroll run calculated',
    { runId, employeeCount: lineInserts.length, totalGross },
    'payrollRunService',
  );
  return mapRunRow(updated);
}
