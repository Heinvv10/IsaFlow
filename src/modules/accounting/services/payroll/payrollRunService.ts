import { log } from '@/lib/logger';
import { listPayrollRunEmployees, listTaxNumbersForCompany } from './payrollEmployeeService';
import { payrollRunReadDate } from './payrollRunReadDate';
import { proRataValidation, recurringRowsNeedingProRata } from './payrollRecurringProRata';
import { calculatePayrollLine } from './payrollCalculator';
import { applySdlToLines, estimateAnnualRemuneration } from './sdlLeviabilityService';
import { isContractorLine } from './payrollOutsideTables';
import { validateEmployee, validateEti, validatePayrollLine } from './validationEngine';
import { getTaxYear, getTaxYearConfig } from './taxTables';
import {
  isPayrollRunLocked, lockCompanyPayrollApprovals, lockPayrollRunHeader, PayrollRunLockedError, saveCalculatedRunTotals,
} from './payrollRunLock';
import { journalInForceOrNull } from './payrollJournalChain';
import type { PayrollEmployee, PayrollPeriod } from './payrollTypes';
import type { ApplyLoanResult } from './payrollLoanService';
import { applyRunLoans } from './payrollRunLoanApplication';
import { appendLoanComponents, loadLoanComponents } from './payrollRunLoanComponents';
import { fringeNotRecordedResults, runOfficialRate, withheldLineResults, type WithheldLoan } from './payrollLoanWithholding';
import { prepareRunComponents } from './payrollRunComponents';
import { listSeveranceOnlyRunEmployees } from './payrollSeveranceDirective';
import { replaceRunLines, type LineInsert } from './payrollRunLineWriter';
import { laterPeriodsWarnings, loadPayeYearToDate } from './payrollYearToDate';
import { recordPreparedApproval } from './payrollRunPrepared';
import { blockedLoanValidation, judgeLoanApplications } from './payrollRunLoanDecision';
import { assertNoLaterEtiJournal } from './etiPeriodGuard';
import { withEtiPriorMonths } from './etiPriorEmployment';
import { mapRunRow, type PayrollRunSummary } from './payrollRunHeaders';
import { assertRunKindSupported } from './payrollRunKindGuard';
import { payFrequencyOf } from './payrollFrequency';

export { getPayrollRunLines, type PayrollRunLine } from './payrollRunLines';

export {
  createPayrollRun, getPayrollRun, listPayrollRuns, mapRunRow, PayrollRunDuplicateError, type PayrollRunSummary,
} from './payrollRunHeaders';

export async function calculatePayrollRun(
  runId: string,
  companyId: string,
  preparedBy: string | null = null,
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
  // Hein ruling R-A (wave 5 ET): no recalculation while a later month of the ETI period has posted the carry.
  await assertNoLaterEtiJournal(companyId, period);
  // Components are read as at the period's last day, a plain calendar string (payrollRunReadDate).
  const readDate = payrollRunReadDate(period);

  const payFrequency = payFrequencyOf(run.pay_frequency);
  const employees = await withEtiPriorMonths(companyId, await listPayrollRunEmployees(companyId, period, payFrequency)); // ET: a rehire continues its ETI months
  // Wave 6 FQa: a run, employee or assignment this release cannot cost is refused here, before the first write
  // (listSeveranceOnlyRunEmployees below frees reversed payments; applyRunLoans commits loan deductions).
  await assertRunKindSupported(companyId, runId, 'calculate', { employeeIds: employees.map((e) => e.id) });
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
  const severanceOnly = await listSeveranceOnlyRunEmployees(companyId, runId, period, payFrequency);
  const population: Array<{ employee: PayrollEmployee; severanceOnly: boolean }> = [
    ...employees.map(employee => ({ employee, severanceOnly: false })),
    ...severanceOnly.map(employee => ({ employee, severanceOnly: true })),
  ];
  // Earlier periods of the tax year, for the cumulative PAYE (PAYE 4a follow-ups G4).
  const ytdByEmployee = await loadPayeYearToDate(companyId, runId, period, population.map(p => p.employee.id));
  const laterApproved = await laterPeriodsWarnings(companyId, runId, period);
  // Recurring rows the last-day read pays in full or drops: flagged on the line, refused at approval.
  const proRata = await recurringRowsNeedingProRata(companyId, period, employees.map(e => e.id));

  const prepared = await prepareRunComponents({ companyId, runId, period, readDate, population });

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

  for (const { employee, severanceOnly: onlySeverance, components, terminationWarnings, regularPayDirective } of prepared) {
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
      regularPayDirective,
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
      sdl: 0, sdlExempt: false, // set below (applySdlToLines), once the run's own leviable total decides leviability
      sdlLeviable: line.sdlLeviable, sdlApplicable: line.sdlApplicable,
      donationReceipted: line.donationReceipted, donationBase: line.donationBase, donationDeduction: line.donationDeduction,
      eti: line.eti.monthlyEti,
      netPay: line.netPay,
      componentBreakdown: JSON.stringify(line.componentBreakdown), explanation: line.explanations,
      validationResults: JSON.stringify([
        ...empValidation, ...lineValidation, ...validateEti(employee, line.eti),
        ...line.validationResults, ...terminationWarnings, ...(withheldResults.get(employee.id) ?? []), ...(fringeWarnings.has(employee.id) ? [fringeWarnings.get(employee.id)!] : []),
        ...(blockedLoans.has(employee.id) ? [blockedLoanValidation(
          blockedLoans.get(employee.id)!.applications, blockedLoans.get(employee.id)!.rawNet,
          `${employee.firstName} ${employee.lastName}`.trim(),
        )] : []),
        // Remuneration before deductions feeds later months even when a deduction reduced this line to nil.
        ...((line.periodicRemuneration > 0 || line.annualPaymentRemuneration > 0) && laterApproved.has(employee.id)
          ? [laterApproved.get(employee.id)!] : []),
        ...proRata.filter(r => r.employeeId === employee.id).map(proRataValidation),
      ]),
    });

    totalGross += line.grossPay;
    // A contractor's fees are not remuneration for the employer's SDL s4(b) threshold (the history excludes them too).
    if (!isContractorLine(line.validationResults)) totalRemuneration += line.remuneration;
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
  }, preparedBy ?? (run.created_by == null ? null : String(run.created_by)));
  const author = preparedBy ?? (run.created_by == null ? null : String(run.created_by));
  await recordPreparedApproval(companyId, runId, author);

  log.info(
    'Payroll run calculated',
    { runId, employeeCount: lineInserts.length, totalGross },
    'payrollRunService',
  );
  return mapRunRow(updated);
}
