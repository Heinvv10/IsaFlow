import { log } from '@/lib/logger';
import { listPayrollRunEmployees, listTaxNumbersForCompany } from './payrollEmployeeService';
import { payrollRunReadDate } from './payrollRunReadDate';
import { proRataValidation, recurringRowsNeedingProRata } from './payrollRecurringProRata';
import { calculatePayrollLine } from './payrollCalculator';
import { assertPspRunComponents, assertReopenedRunKeepsPspTreatment, pspGuardWindow } from './pspComponentGuard';
import { applySdlToLines, estimateAnnualRemuneration } from './sdlLeviabilityService';
import { loadMonthToDateSdl } from './payrollSdlMonthToDate';
import { isContractorLine } from './payrollOutsideTables';
import { validateEmployee, validateEti, validatePayrollLine } from './validationEngine';
import { getTaxYear, getTaxYearConfig } from './taxTables';
import {
  isPayrollRunLocked, lockCompanyPayrollApprovals, lockPayrollRunHeader, PayrollRunLockedError, saveCalculatedRunTotals,
} from './payrollRunLock';
import { journalInForceOrNull } from './payrollJournalChain';
import type { LineCadence, PayrollEmployee, PayrollLineResult, PayrollPeriod } from './payrollTypes';
import type { ApplyLoanResult } from './payrollLoanService';
import { applyRunLoans } from './payrollRunLoanApplication';
import { appendLoanComponents, loadLoanComponents } from './payrollRunLoanComponents';
import { fringeNotRecordedResults, runOfficialRate, withheldLineResults, type WithheldLoan } from './payrollLoanWithholding';
import { prepareRunComponents, type PreparedRunEmployee } from './payrollRunComponents';
import { listSeveranceOnlyRunEmployees } from './payrollSeveranceDirective';
import { replaceRunLines, type LineInsert } from './payrollRunLineWriter';
import { laterPeriodsWarnings, loadPayeYearToDate } from './payrollYearToDate';
import { recordPreparedApproval } from './payrollRunPrepared';
import { blockedLoanValidation, judgeLoanApplications } from './payrollRunLoanDecision';
import { assertNoLaterEtiJournal } from './etiPeriodGuard';
import { withEtiPriorMonths } from './etiPriorEmployment';
import { mapRunRow, type PayrollRunSummary } from './payrollRunHeaders';
import { assertRunKindSupported } from './payrollRunKindGuard';
import { offCycleReasonOf, payFrequencyOf, runKindOf, runPeriodOf } from './payrollFrequency';
import { assertFrequencyCostable, frequencyRunOf } from './payrollFrequencyGuard';
import { loadLineCadences } from './payrollRunCadence';
import { listOffCycleEmployees, prepareOffCycleComponents, type OffCyclePrepared } from './payrollOffCyclePopulation';
import { assertOffCycleBeforeClose } from './payrollOffCycleRun';
import { assertPreparerSupported } from './payrollPreparerGuard';
import { loadRunGarnisheeOrders, offCycleGarnisheeNotice, replaceRunGarnisheeDeductions } from './payrollGarnisheeRun';

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
  // Wave 6 HYb: the preparer this calculation records must be one R-035 approval can carry (payrollPreparerGuard).
  await assertPreparerSupported(companyId, preparedBy ?? (run.created_by == null ? null : String(run.created_by)));
  // A weekly or fortnightly run carries its own dates (wave 6 FQc): its reads, population and pro-rata follow them.
  const period: PayrollPeriod = runPeriodOf(run);
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
  // Wave 6 OC: an off-cycle run pays the employees it was created with, only its bonus or termination pay-outs.
  const offCycle = runKindOf(run.run_kind) === 'off_cycle' ? offCycleReasonOf(run.off_cycle_reason) : null;
  if (offCycle === 'unsupported') throw new Error('Off-cycle run with an unknown reason');
  const employees = await withEtiPriorMonths(companyId, offCycle // ET: a rehire continues its ETI months
    ? await listOffCycleEmployees(companyId, runId) : await listPayrollRunEmployees(companyId, period, payFrequency));
  // Wave 6 FQa: a run, employee or assignment this release cannot cost is refused here, before the first write
  // (listSeveranceOnlyRunEmployees below frees reversed payments; applyRunLoans commits loan deductions).
  await assertRunKindSupported(companyId, runId, 'calculate', { employeeIds: employees.map((e) => e.id) });
  // Wave 6 FQc: terms a weekly run cannot cost, its EMP201 month, an employee's mid-year frequency change (no write yet).
  const frequencyRun = frequencyRunOf(run);
  if (frequencyRun) await assertFrequencyCostable(companyId, frequencyRun, employees.map((e) => e.id));
  // Wave 6 OC: an off-cycle run paid on or after its month's closing regular run is refused (409, no write).
  await assertOffCycleBeforeClose(companyId, run);
  // Wave 6 PSP (M3/M4): a PSP with a retirement fund, s18A, fringe-benefit or loan item is refused (409) before any write.
  await assertPspRunComponents(companyId, pspGuardWindow(period), employees.map((e) => e.id)); // the run's own dates (FQc)
  // M2: a reopened month is not re-costed under a different PSP treatment than it was approved with (409).
  await assertReopenedRunKeepsPspTreatment(companyId, runId, employees.map((e) => e.id));
  const allTaxNumbers = await listTaxNumbersForCompany(companyId);

  let totalGross = 0;
  let totalRemuneration = 0;
  let totalPaye = 0;
  let totalUifEmployee = 0;
  let totalUifEmployer = 0;
  let totalEti = 0;
  let totalNet = 0;

  const lineInserts: LineInsert[] = [];
  const garnisheeLines: Array<{ employeeId: string; garnishees: PayrollLineResult['garnishees'] }> = [];

  // Leavers from earlier periods whose severance directive this run may pay:
  // the severance line alone, no salary, recurring components or loans, and so
  // no UIF or SDL (audit 2026-10-18 P3, payrollSeveranceDirective.ts).
  const severanceOnly = offCycle ? [] : await listSeveranceOnlyRunEmployees(companyId, runId, period, payFrequency);
  const population: Array<{ employee: PayrollEmployee; severanceOnly: boolean }> = [
    ...employees.map(employee => ({ employee, severanceOnly: false })),
    ...severanceOnly.map(employee => ({ employee, severanceOnly: true })),
  ];
  // Earlier periods of the tax year, for the cumulative PAYE (PAYE 4a follow-ups G4).
  const ytdByEmployee = await loadPayeYearToDate(companyId, runId, period, population.map(p => p.employee.id));
  const laterApproved = await laterPeriodsWarnings(companyId, runId, period);
  // A weekly or fortnightly line's UIF and ETI month to date (payrollRunCadence); none for a monthly run.
  const cadences = !frequencyRun ? new Map<string, LineCadence>()
    : await loadLineCadences(companyId, runId, frequencyRun, population.map(p => p.employee));
  // Recurring rows the last-day read pays in full or drops: flagged on the line, refused at approval.
  const proRata = offCycle ? [] : await recurringRowsNeedingProRata(companyId, period, employees.map(e => e.id));

  const prepared: Array<OffCyclePrepared | (PreparedRunEmployee & { monthEarlier?: undefined })> = offCycle
    ? await prepareOffCycleComponents({ companyId, runId, period, reason: offCycle, employees })
    : await prepareRunComponents({ companyId, runId, period, readDate, population });

  // GA: each employee's garnishee orders in force for the period (a severance-only leaver's line takes none).
  const garnishees = await loadRunGarnisheeOrders(companyId, employees.map(e => e.id), run.period_start, run.period_end);

  // Preview all due loans before any payment write. A blocked employee takes none of them.
  const loanComponents = await loadLoanComponents(companyId);
  const withheld: WithheldLoan[] = [];
  const blockedLoans = new Map<string, { applications: ApplyLoanResult[]; rawNet: number }>();
  const preparedByEmployee = new Map(prepared.map((item) => [item.employee.id, item]));
  // An off-cycle run pays no loan instalment: its line pays only the bonus or the termination pay-outs.
  const loansByEmployee = offCycle ? new Map<string, ApplyLoanResult[]>() : await applyRunLoans({
    companyId, runId, periodYear: period.year, periodMonth: period.month, officialRate: runOfficialRate(),
    journalEntryId: await journalInForceOrNull(companyId, run.journal_entry_id),
    employeeIds: new Set(employees.map(e => e.id)),
    components: { deduction: loanComponents.deduction != null, fringe: loanComponents.fringe != null },
    onWithheld: (w) => withheld.push(w),
    judgePay: (employeeId, applications) => judgeLoanApplications({
      basis: preparedByEmployee.get(employeeId), applications, loanComponents, period, taxYear,
      ytd: ytdByEmployee.get(employeeId), cadence: cadences.get(employeeId), garnisheeOrders: garnishees.get(employeeId),
    }),
    onPayBlocked: (employeeId, applications, rawNet) => blockedLoans.set(employeeId, { applications, rawNet }),
  });
  const withheldResults = withheldLineResults(withheld);
  const fringeWarnings = fringeNotRecordedResults(loansByEmployee, loanComponents);

  for (const item of prepared) {
    const { employee, severanceOnly: onlySeverance, components, terminationWarnings, regularPayDirective } = item;
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
      ...(item.monthEarlier ? { monthEarlier: item.monthEarlier } : {}),
      cadence: cadences.get(employee.id),
      // An off-cycle run takes no instalment (review #1679e): the month's is the regular run's; the line says so.
      garnisheeOrders: onlySeverance || offCycle ? undefined : garnishees.get(employee.id),
    });
    garnisheeLines.push({ employeeId: employee.id, garnishees: line.garnishees });

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
        ...line.validationResults, ...terminationWarnings, ...(offCycle ? offCycleGarnisheeNotice(garnishees.get(employee.id)) : []), ...(withheldResults.get(employee.id) ?? []), ...(fringeWarnings.has(employee.id) ? [fringeWarnings.get(employee.id)!] : []),
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
  // SDL as a month-to-date catch-up (wave 6 OC, review #1620 final breaker H): liable once the month is, and a liable run
  // carries what the month's earlier final runs did not levy (payrollSdlMonthToDate).
  const totalSdl = applySdlToLines(lineInserts, annualRemuneration, taxYear, await loadMonthToDateSdl(companyId, runId));

  await replaceRunLines(runId, companyId, lineInserts);
  await replaceRunGarnisheeDeductions(companyId, runId, garnisheeLines); // GA: recorded here; balances move only at approval

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
