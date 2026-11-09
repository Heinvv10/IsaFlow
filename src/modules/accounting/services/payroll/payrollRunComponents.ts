import { getEmployeeComponents } from './payrollComponentService';
import { appendTerminationIfEndingThisPeriod, severanceOnlyComponents } from './payrollRunTermination';
import type { EmployeeComponent, PayrollEmployee, PayrollPeriod, ValidationResult } from './payrollTypes';

export type PreparedRunEmployee = {
  employee: PayrollEmployee;
  severanceOnly: boolean;
  components: EmployeeComponent[];
  terminationWarnings: ValidationResult[];
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
  return prepared;
}
