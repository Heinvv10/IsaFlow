import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { listPayrollRunEmployees, listTaxNumbersForCompany } from './payrollEmployeeService';
import { getEmployeeComponents } from './payrollComponentService';
import { payrollRunReadDate } from './payrollRunReadDate';
import { proRataValidation, recurringRowsNeedingProRata } from './payrollRecurringProRata';
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
import { appendLoanComponents, loadLoanComponents } from './payrollRunLoanComponents';
import { fringeNotRecordedResults, runOfficialRate, withheldLineResults, type WithheldLoan } from './payrollLoanWithholding';
import { appendTerminationIfEndingThisPeriod, severanceOnlyComponents } from './payrollRunTermination';
import { listSeveranceOnlyRunEmployees } from './payrollSeveranceDirective';
import { replaceRunLines, type LineInsert } from './payrollRunLineWriter';
import { laterPeriodsWarnings, loadPayeYearToDate } from './payrollYearToDate';
import { blockedLoanValidation, judgeLoanApplications } from './payrollRunLoanDecision';

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
  // Components are read as at the period's last day, a plain calendar string (payrollRunReadDate).
  const readDate = payrollRunReadDate(period);
  // Only for validateEti's ETI_TABLE_UNCONFIRMED warning, which reads its month through local getters. ETI itself
  // (table, age, months employed) is worked out in calculatePayrollLine on its own local day-28 Date, not on this nor
  // on readDate; getAge there compares days, so ETI age is still taken on the 28th.
  const periodDate = new Date(period.year, period.month - 1, 28);

  const employees = await listPayrollRunEmployees(companyId, period);
  const allTaxNumbers = await listTaxNumbersForCompany(companyId);

  let totalGross = 0;
  let totalRemuneration = 0;
  let totalPaye = 0;
  let totalUifEmployee = 0;
  let totalUifEmployer = 0;
  let totalEti = 0;
  let totalNet = 0;

  const lineInserts: LineInsert[] = [];

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
  // Recurring rows the last-day read pays in full or drops: flagged on the line, refused at approval.
  const proRata = await recurringRowsNeedingProRata(companyId, period, employees.map(e => e.id));

  type Prepared = { employee: PayrollEmployee; severanceOnly: boolean; components: EmployeeComponent[]; terminationWarnings: ValidationResult[] };
  const prepared: Prepared[] = [];
  for (const { employee, severanceOnly: onlySeverance } of population) {
    const terminationWarnings: ValidationResult[] = [];
    const components = onlySeverance
      ? await severanceOnlyComponents(companyId, runId, employee, period, terminationWarnings)
      : await appendTerminationIfEndingThisPeriod(
        companyId, runId, employee, await getEmployeeComponents(employee.id, companyId, readDate), period, terminationWarnings,
      );
    if (onlySeverance && components.length === 0) continue;
    prepared.push({ employee, severanceOnly: onlySeverance, components, terminationWarnings });
  }

  // Preview all due loans before any payment write. A blocked employee takes none of them.
  const loanComponents = await loadLoanComponents(companyId);
  const withheld: WithheldLoan[] = [];
  const blockedLoans = new Map<string, { applications: ApplyLoanResult[]; rawNet: number }>();
  const preparedByEmployee = new Map(prepared.map((item) => [item.employee.id, item]));
  const loansByEmployee = await applyRunLoans({
    companyId, runId, periodYear: period.year, periodMonth: period.month, officialRate: runOfficialRate(),
    journalEntryId: await journalInForceOrNull(companyId, run.journal_entry_id),
    employeeIds: new Set(employees.map(e => e.id)),
    components: { deduction: loanComponents.deduction != null, fringe: loanComponents.fringe != null },
    onWithheld: (w) => withheld.push(w),
    judgePay: (employeeId, applications) => judgeLoanApplications({
      basis: preparedByEmployee.get(employeeId), applications, loanComponents, period, taxYear,
      ytd: ytdByEmployee.get(employeeId),
    }),
    onPayBlocked: (employeeId, applications, rawNet) => blockedLoans.set(employeeId, { applications, rawNet }),
  });
  const withheldResults = withheldLineResults(withheld);
  const fringeWarnings = fringeNotRecordedResults(loansByEmployee, loanComponents);

  for (const { employee, severanceOnly: onlySeverance, components, terminationWarnings } of prepared) {
    const loanApplications: ApplyLoanResult[] = onlySeverance ? [] : loansByEmployee.get(employee.id) ?? [];
    const componentsWithLoans = appendLoanComponents(components, loanApplications, loanComponents);

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
      // After the retirement fund deduction: a contribution can legitimately bring it under the threshold.
      taxableIncome: line.taxableIncome - line.retirementDeduction,
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
      additionalMedicalCredit: line.additionalMedicalCredit,
      medicalSchemeFees: line.medicalSchemeFees,
      retirementContributions: line.retirementContributions,
      retirementDeduction: line.retirementDeduction,
      uifEmployee: line.uif.employeeContribution,
      uifEmployer: line.uif.employerContribution,
      sdl: 0, // set below, once the run's own leviable total decides leviability
      sdlLeviable: line.sdlLeviable,
      eti: line.eti.monthlyEti,
      netPay: line.netPay,
      componentBreakdown: JSON.stringify(line.componentBreakdown),
      validationResults: JSON.stringify([
        ...empValidation, ...lineValidation, ...validateEti(employee, line.eti, periodDate),
        ...line.validationResults, ...terminationWarnings, ...(withheldResults.get(employee.id) ?? []), ...(fringeWarnings.has(employee.id) ? [fringeWarnings.get(employee.id)!] : []),
        ...(blockedLoans.has(employee.id) ? [blockedLoanValidation(
          blockedLoans.get(employee.id)!.applications, blockedLoans.get(employee.id)!.rawNet,
        )] : []),
        // Remuneration before taxable deductions feeds later months even when a deduction reduced this line to nil.
        ...((line.periodicRemuneration > 0 || line.annualPaymentRemuneration > 0) && laterApproved.has(employee.id)
          ? [laterApproved.get(employee.id)!] : []),
        ...proRata.filter(r => r.employeeId === employee.id).map(proRataValidation),
      ]),
    });

    totalGross += line.grossPay;
    totalRemuneration += line.remuneration;
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
    companyId, period, r(totalRemuneration), runId,
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
