import { getEmployeeComponents } from './payrollComponentService';
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
      employee, severanceOnly: onlySeverance, components, terminationWarnings,
      regularPayDirective: directives.get(employee.id) ?? { current: null, ended: null },
    });
  }
  return prepared;
}
