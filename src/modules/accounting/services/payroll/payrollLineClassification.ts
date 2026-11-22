/**
 * A line's PAYE employment class (G21 p. 28; moved out of payrollCalculator to keep it under the file cap). An off-cycle
 * line is classified on the month's time-worked earnings, its earlier lines' included (gate ruling 2 on 7630d9379f): a
 * bonus alone has none. When an earlier historical line could not be rebuilt, its class as stored stands (storedClass,
 * gate ruling 1 on e0eec1dea1).
 */
import { classifyEmployment, timeWorkedEarnings, type EmploymentClassification } from './employmentTerms';
import { storedClassification, type MonthEarlierLines } from './payrollOffCycleMonth';
import type { EmployeeComponent, PayrollEmployee } from './payrollTypes';

export function lineClassification(args: {
  employee: PayrollEmployee; taxYear: number; components: EmployeeComponent[]; monthEarlier?: MonthEarlierLines;
  dayPay: (timeWorked: number) => { earnings: number; employedShare: number };
}): EmploymentClassification {
  const { employee, taxYear, components, monthEarlier, dayPay } = args;
  if (monthEarlier?.storedClass) return storedClassification(monthEarlier.storedClass);
  const timeWorked = timeWorkedEarnings(components) + (monthEarlier ? timeWorkedEarnings(monthEarlier.etiComponents) : 0);
  return classifyEmployment(employee, taxYear, dayPay(timeWorked));
}
