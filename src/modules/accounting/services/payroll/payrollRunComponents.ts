import { getEmployeeComponents } from './payrollComponentService';
import { applyFringeBenefits, FringeBenefitConfigError, selectBenefit } from './fringeBenefits';
import { loadFringeBenefitsByEmployee, loadVehicleBenefitComponent } from './fringeBenefitService';
import { markNonCashEmployerBenefits } from './employerContributions';
import { appendTerminationIfEndingThisPeriod, severanceOnlyComponents } from './payrollRunTermination';
import { loadRegularPayDirectives } from './payrollRunRegularDirective';
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
  const benefits = await loadFringeBenefitsByEmployee(companyId, population.map((p) => p.employee.id));
  const vehicleComponent = await loadVehicleBenefitComponent(companyId);
  for (const { employee, severanceOnly: onlySeverance } of population) {
    const terminationWarnings: ValidationResult[] = [];
    const components = onlySeverance
      ? await severanceOnlyComponents(companyId, runId, employee, period, terminationWarnings)
      : await appendTerminationIfEndingThisPeriod(
        companyId, runId, employee, await getEmployeeComponents(employee.id, companyId, readDate), period, terminationWarnings,
      );
    if (onlySeverance && components.length === 0) continue;
    // The whole reading (partial month, overlap, unusable row) reaches the line: each is warned there, none dropped.
    prepared.push({
      employee, severanceOnly: onlySeverance, terminationWarnings,
      components: onlySeverance ? components : withFringe(components, benefits.get(employee.id) ?? [], vehicleComponent, period, terminationWarnings),
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
