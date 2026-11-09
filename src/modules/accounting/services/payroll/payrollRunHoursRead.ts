/**
 * What the grid needs to record hours and days (HD): the Basic Salary (3601) component the quantity is kept on,
 * and who is paid by the hour or day at what rate.
 */
import { normaliseSarsCode } from './payeAnnualPayment';
import { rateOf, unitOf } from './payrollRunHours';
import type { PayrollEmployee, QuantityUnit } from './payrollTypes';

export interface RunInputHours {
  componentId: string | null;
  employees: Array<{ employeeId: string; unit: QuantityUnit; rate: number | null }>;
}

/** The company's Basic Salary component among the editable ones (first by name: the list is ordered), or undefined. */
export const basicSalaryOf = <T extends { sarsSourceCode: string; componentType: string }>(components: T[]): T | undefined =>
  components.find((c) => c.componentType === 'earning' && normaliseSarsCode(c.sarsSourceCode) === '3601');

export function hoursInputsOf(employees: PayrollEmployee[]): RunInputHours['employees'] {
  return employees.flatMap((e) => {
    const unit = unitOf(e);
    return unit == null ? [] : [{ employeeId: e.id, unit, rate: rateOf(e) }];
  });
}
