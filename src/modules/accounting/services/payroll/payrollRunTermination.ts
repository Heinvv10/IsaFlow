/**
 * The termination components a run line pays: leave pay-out and notice pay in
 * the final run (both 3605, annual payments), and severance (3901) only under
 * an approved SARS directive, at the directive's figures (audit 2026-10-18 P3,
 * payrollSeveranceDirective.ts). Extracted from payrollRunService.
 *
 * Warnings pushed to the line:
 *   TERMINATION_ALREADY_PAID      another approved or paid run paid the pay-outs (P4).
 *   SEVERANCE_AWAITING_DIRECTIVE  severance is due and no directive is approved: left out.
 *   SEVERANCE_PAID_BY_DIRECTIVE   the directive was paid elsewhere: not paid again.
 *   SEVERANCE_DIRECTIVE_UNPAYABLE an approved directive's tax figure is below nil or above the gross.
 *   SEVERANCE_DIRECTIVE_MISMATCH  the directive's gross differs from the calculated severance;
 *                                 the directive's figures are paid (decided 2026-10-20).
 *   SEVERANCE_CAPTURED_AS_COMPONENT  the line, or an earlier declarable run, already pays a
 *                                 hand-made 3901 component: the directive's line is not added
 *                                 (no double payment); on this line approval stays refused until
 *                                 that component is removed (lump_sum_without_directive).
 */

import { log } from '@/lib/logger';
import { getEmployeeComponents } from './payrollComponentService';
import {
  buildTerminationComponents,
  getTerminationDetails,
  getAnnualLeaveBalance,
  yearsOfService,
  type TerminationReason,
} from './payrollTerminationService';
import { findPaidTerminationRun } from './payrollTerminationPaidCheck';
import { findHandMadeLumpSumPaid, findSeveranceDirectiveForRun, severanceDirectiveComponent } from './payrollSeveranceDirective';
import { normaliseSarsCode } from './payeAnnualPayment';
import type { EmployeeComponent, PayrollEmployee, PayrollPeriod, ValidationResult } from './payrollTypes';

const SYNTHETIC_SEVERANCE_ID = 'synthetic:termination:severance';

const rands = (n: number): string => `R ${n.toFixed(2)}`;
const who = (e: PayrollEmployee): string => `${e.employeeNumber} (${e.firstName} ${e.lastName})`;

/**
 * Leave pay-out and notice pay for an employee leaving this period, and the
 * severance the termination flow calculates for them (paid only by directive).
 * Null when no termination reason is captured or there is no salary to base
 * them on.
 */
async function terminationPayouts(
  companyId: string,
  employee: PayrollEmployee,
  salaryComponents: EmployeeComponent[],
  leaveYear: number | null,
): Promise<{ payouts: EmployeeComponent[]; severance: number } | null> {
  const { endDate, startDate } = employee;
  if (!endDate) return null;
  const details = await getTerminationDetails(companyId, employee.id);
  if (!details || !details.reason) return null;
  const monthlySalary = salaryComponents
    .filter((c) => c.component.componentType === 'earning')
    .reduce((sum, c) => sum + c.amount, 0);
  if (monthlySalary <= 0) return null;

  const unusedLeaveDays = details.includeLeavePayout && leaveYear != null
    ? await getAnnualLeaveBalance(companyId, employee.id, leaveYear)
    : 0;
  const all = buildTerminationComponents({
    monthlySalary,
    unusedLeaveDays,
    noticePeriodDays: details.noticePeriodDays ?? 0,
    servedNoticeDays: details.servedNoticeDays ?? 0,
    severanceWeeksPerYear: details.severanceWeeksPerYear ?? 0,
    yearsOfService: yearsOfService(startDate.toISOString().slice(0, 10), endDate.toISOString().slice(0, 10)),
    includeLeavePayout: details.includeLeavePayout,
    reason: details.reason as TerminationReason,
  });
  const severance = all.find(c => c.component.id === SYNTHETIC_SEVERANCE_ID)?.amount ?? 0;
  return { payouts: all.filter(c => c.component.id !== SYNTHETIC_SEVERANCE_ID), severance };
}

/**
 * The severance line, if a directive available to this run pays it, with the
 * warning that explains a severance left out. `calculated` is the termination
 * flow's figure, or null when it is not known (the pay-outs were paid
 * elsewhere), which suppresses the mismatch and awaiting warnings.
 */
async function severanceByDirective(
  companyId: string,
  runId: string,
  employee: PayrollEmployee,
  period: PayrollPeriod,
  calculated: number | null,
  warnings: ValidationResult[],
  components: EmployeeComponent[] = [],
): Promise<EmployeeComponent[]> {
  const { available, paidElsewhere, unpayable } = await findSeveranceDirectiveForRun(companyId, employee.id, runId, period);
  // Severance captured by hand is a 3901, the directive's own code (as findHandMadeLumpSumPaid);
  // another lump sum (3915, 3920, …) is a different benefit and is refused by the gate on its own.
  const handMade = components.find(c => c.component.componentType === 'earning' && normaliseSarsCode(c.component.sarsSourceCode) === '3901');
  if (available && handMade) {
    warnings.push({
      code: 'SEVERANCE_CAPTURED_AS_COMPONENT',
      severity: 'warning',
      message: `${who(employee)} has severance as a pay component (${handMade.component.name}, code ${handMade.component.sarsSourceCode}) `
        + `and an approved SARS directive ${available.number ?? available.id}. The directive is not added beside it; remove the component `
        + 'and recalculate, and the run pays the severance at the directive figures.',
    });
    return [];
  }
  const paidByHand = available ? await findHandMadeLumpSumPaid(companyId, employee.id, runId) : null;
  if (available && paidByHand) {
    warnings.push({
      code: 'SEVERANCE_CAPTURED_AS_COMPONENT',
      severity: 'warning',
      message: `${who(employee)} was already paid ${paidByHand.name} as a pay component in the `
        + `${paidByHand.year}-${String(paidByHand.month).padStart(2, '0')} run, under no directive. SARS directive `
        + `${available.number ?? available.id} is not paid on top of it; correct that payment by hand if the directive replaces it.`,
    });
    return [];
  }
  if (available) {
    if (calculated != null && Math.abs(available.gross - calculated) >= 0.005) {
      warnings.push({
        code: 'SEVERANCE_DIRECTIVE_MISMATCH',
        severity: 'warning',
        message: `Severance for ${who(employee)} is paid at its SARS directive ${available.number ?? available.id}: `
          + `directive ${rands(available.gross)}, calculated ${rands(calculated)} — request a new directive if the agreed severance changed.`,
      });
    }
    return [severanceDirectiveComponent(available)];
  }
  if (unpayable) {
    warnings.push({
      code: 'SEVERANCE_DIRECTIVE_UNPAYABLE',
      severity: 'warning',
      message: `Severance for ${who(employee)} is not paid: its approved SARS directive ${unpayable.number ?? unpayable.id} carries a tax figure `
        + 'below nil or above the gross. Correct the directive; the first run after that pays the severance.',
    });
  } else if (paidElsewhere) {
    warnings.push({
      code: 'SEVERANCE_PAID_BY_DIRECTIVE',
      severity: 'warning',
      message: `Severance for ${who(employee)} was already paid under its SARS directive, outside this run, so it is not paid again.`,
    });
  } else if (calculated != null && calculated > 0) {
    warnings.push({
      code: 'SEVERANCE_AWAITING_DIRECTIVE',
      severity: 'warning',
      message: `Severance of ${rands(calculated)} for ${who(employee)} is not paid in this run: SARS taxes it only at the figures on a `
        + 'tax directive (IRP3(a)), and none is approved. Apply for the directive; the first run after it is approved pays the severance alone.',
    });
  }
  return [];
}

/**
 * Append the termination components when the employee's end_date falls within
 * this payroll period. Leave pay-out and notice pay need a termination reason
 * on the profile, and are skipped, with TERMINATION_ALREADY_PAID, when another
 * approved or paid run already paid them (an end date moved to a later month
 * after the final pay). Severance is paid only by directive, whichever run
 * that is (payrollSeveranceDirective).
 */
export async function appendTerminationIfEndingThisPeriod(
  companyId: string,
  runId: string,
  employee: PayrollEmployee,
  components: EmployeeComponent[],
  period: PayrollPeriod,
  warnings: ValidationResult[],
): Promise<EmployeeComponent[]> {
  const { endDate } = employee;
  if (!endDate) return components;
  if (endDate.getFullYear() !== period.year || endDate.getMonth() + 1 !== period.month) return components;

  const paid = await findPaidTerminationRun(companyId, employee.id, runId);
  let payouts: EmployeeComponent[] = [];
  let calculated: number | null = null;
  if (paid) {
    warnings.push({
      code: 'TERMINATION_ALREADY_PAID',
      severity: 'warning',
      message: `Leave, notice and severance pay-outs for this employee were already paid in the ${paid.year}-${String(paid.month).padStart(2, '0')} run, `
        + 'so they are not paid again. If they were re-employed and have left again, the second pay-out must be captured by hand.',
    });
  } else {
    const t = await terminationPayouts(companyId, employee, components, period.year);
    payouts = t?.payouts ?? [];
    calculated = t?.severance ?? 0;
  }
  const severance = await severanceByDirective(companyId, runId, employee, period, calculated, warnings, components);
  const termination = [...payouts, ...severance];
  if (termination.length > 0) {
    log.info('Termination components injected into payroll run', {
      companyId, employeeId: employee.id, period, count: termination.length,
    }, 'payrollRunTermination');
  }
  return [...components, ...termination];
}

/**
 * The line of an employee who left before this period and whose severance
 * directive is available to it: the severance alone, no salary, no recurring
 * component (listSeveranceOnlyRunEmployees). Empty, with the reason logged,
 * when the directive is unpayable or the severance was paid by hand already. The mismatch warning compares the
 * directive with the severance calculated on the pay they left on.
 */
export async function severanceOnlyComponents(
  companyId: string,
  runId: string,
  employee: PayrollEmployee,
  period: PayrollPeriod,
  warnings: ValidationResult[],
): Promise<EmployeeComponent[]> {
  const salaryAtExit = employee.endDate ? await getEmployeeComponents(employee.id, companyId, employee.endDate) : [];
  const t = await terminationPayouts(companyId, employee, salaryAtExit, null);
  const line = await severanceByDirective(companyId, runId, employee, period, t?.severance ?? 0, warnings);
  // No line, so no line warning to carry it (the run skips the leaver): a run
  // has nowhere else to show why an approved directive was not paid, so log it.
  if (line.length === 0 && warnings.length > 0) {
    log.warn('Severance directive not paid for a leaver', {
      companyId, runId, employeeId: employee.id, codes: warnings.map(w => w.code),
    }, 'payrollRunTermination');
  }
  return line;
}
