import { getEmployeeComponents } from './payrollComponentService';
import { getTerminationDetails } from './payrollTerminationService';
import { isoOfDate } from './payFrequencyPeriods';
import { applyFringeBenefits, FringeBenefitConfigError, selectBenefit } from './fringeBenefits';
import { loadFringeBenefitsByEmployee, loadVehicleBenefitComponent } from './fringeBenefitService';
import { markNonCashEmployerBenefits } from './employerContributions';
import { costPercentOfRfi } from './rfi';
import { appendTerminationIfEndingThisPeriod, severanceOnlyComponents } from './payrollRunTermination';
import { loadRegularPayDirectives } from './payrollRunRegularDirective';
import { assertRunKeepsItsDirectives } from './payrollRunDirectiveUses';
import type { RegularPayDirectiveState } from './directiveRegularPay';
import type { EmployeeComponent, PayrollEmployee, PayrollPeriod, ValidationResult } from './payrollTypes';

export type PreparedRunEmployee = {
  employee: PayrollEmployee;
  severanceOnly: boolean;
  components: EmployeeComponent[];
  terminationWarnings: ValidationResult[];
  /** The IRP3(b)/(c) directive in force this period (DR), for every line the run costs (calculation and the loan preview). */
  regularPayDirective: RegularPayDirectiveState;
};

/** Each run employee's components for the period, termination and severance included (moved out of payrollRunService.ts, unchanged). */
export async function prepareRunComponents(args: {
  companyId: string;
  runId: string;
  period: PayrollPeriod;
  readDate: string;
  population: Array<{ employee: PayrollEmployee; severanceOnly: boolean }>;
}): Promise<PreparedRunEmployee[]> {
  const { companyId, runId, period, readDate, population } = args;
  const prepared: PreparedRunEmployee[] = [];
  const directives = await loadRegularPayDirectives(companyId, population.map(p => p.employee.id), period, runId);
  // An ever-approved run keeps every directive it was approved with: refused here, before the first write (DR round 3).
  await assertRunKeepsItsDirectives(companyId, runId, population, directives);
  const benefits = await loadFringeBenefitsByEmployee(companyId, population.map((p) => p.employee.id));
  const vehicleComponent = await loadVehicleBenefitComponent(companyId);
  for (const { employee, severanceOnly: onlySeverance } of population) {
    const terminationWarnings: ValidationResult[] = [];
    const read = onlySeverance ? [] : await getEmployeeComponents(employee.id, companyId, readDate, period.start);
    const components = onlySeverance
      ? await severanceOnlyComponents(companyId, runId, employee, period, terminationWarnings)
      // A weekly or fortnightly run (it has its own dates, wave 6 FQc) costs no termination pay-outs: refused on the line.
      : period.start ? read.concat(await nonMonthlyTermination(companyId, employee, period, terminationWarnings))
        : await appendTerminationIfEndingThisPeriod(companyId, runId, employee, read, period, terminationWarnings);
    if (onlySeverance && components.length === 0) continue;
    // The whole reading (partial month, overlap, unusable row) reaches the line: each is warned there, none dropped.
    prepared.push({
      employee, severanceOnly: onlySeverance, terminationWarnings,
      components: onlySeverance ? components
        : withRfiCosted(withFringe(components, benefits.get(employee.id) ?? [], vehicleComponent, period, terminationWarnings), terminationWarnings),
      regularPayDirective: directives.get(employee.id) ?? { current: null, ended: null },
    });
  }
  return prepared;
}

/**
 * The employee's components with their fringe benefits applied (vehicle 3802, travel 3701 inclusion) and a 3810
 * earning marked non-cash. A benefit that cannot be shown is an error on the line (blocks approval), not a silent drop.
 */
export function withFringe(
  components: EmployeeComponent[], benefits: Parameters<typeof applyFringeBenefits>[1],
  vehicleComponent: Parameters<typeof applyFringeBenefits>[2], period: PayrollPeriod, warnings: ValidationResult[],
): EmployeeComponent[] {
  try {
    return applyFringeBenefits(components, benefits, vehicleComponent, period);
  } catch (err) {
    if (!(err instanceof FringeBenefitConfigError)) throw err;
    warnings.push({ code: 'FRINGE_BENEFIT_NOT_APPLIED', severity: 'error', message: `${err.message}. The benefit was left off this line: fix it and recalculate.` });
    // The opt-in still decides the 3810, whether or not the vehicle could be shown.
    return markNonCashEmployerBenefits(components, selectBenefit(benefits, 'medical_gross_up', period) !== undefined);
  }
}

/**
 * The percent_of_rfi rows costed on the line's RFI (RF, rfi.ts), after the fringe step, so an employer's 3817 / 3825 /
 * 3828 is already non-cash. Done once here: the loan preview (judgeLoanApplications) and the stored line read the same
 * prepared components, so they cannot cost the contribution differently.
 */
export function withRfiCosted(components: EmployeeComponent[], warnings: ValidationResult[]): EmployeeComponent[] {
  const costed = costPercentOfRfi(components);
  warnings.push(...costed.warnings);
  return costed.components;
}

/**
 * Wave 6 FQc: leave and notice pay-outs are costed on a MONTHLY salary (payrollRunTermination), so a weekly or
 * fortnightly leaver with a termination reason, leaving in this run's period, gets a warning on the line instead:
 * the pay-outs are captured by hand as once-offs. Logged for wave 7. Adds no component.
 */
async function nonMonthlyTermination(
  companyId: string, employee: PayrollEmployee, period: PayrollPeriod, warnings: ValidationResult[],
): Promise<EmployeeComponent[]> {
  const end = employee.endDate ? isoOfDate(employee.endDate) : null;
  if (!end || !period.start || !period.end || end < period.start || end > period.end) return [];
  if (!(await getTerminationDetails(companyId, employee.id))?.reason) return [];
  warnings.push({
    code: 'TERMINATION_NOT_COSTED_AT_FREQUENCY', severity: 'warning',
    message: 'This employee leaves in this run, with a termination reason, but leave and notice pay-outs are worked out on a '
      + 'monthly salary and are not costed on a weekly or fortnightly run yet: none was added. Add any that are due as '
      + 'once-off earnings, then recalculate.',
  });
  return [];
}
