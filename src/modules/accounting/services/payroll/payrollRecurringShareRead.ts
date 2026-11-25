/**
 * W29 (wave 7 PRA): the run's reading of an employee's components with each recurring earning that starts or ends strictly
 * inside employment at its share of the period (payrollRecurringShare). The last-day reader (getEmployeeComponents) does
 * not read a recurring row that ended before the period's last day, so the earnings that ended inside employment in the
 * period are read here as well: recurring, an earning with a plain amount, ending from the period's first day to the day
 * before its last, before the employee's end date (a leaver's own row ending on their end date is the last-day reader's,
 * paid in full: ruling 19), not voided (payrollComponentService.recurringEarningsEndedInPeriod). The two reads are
 * disjoint: the last-day reader takes a recurring row ending before the last day only when it ends on the employee's end date.
 */
import { getEmployeeComponents, recurringEarningsEndedInPeriod } from './payrollComponentService';
import { apportionRecurringRows, periodBoundsOf } from './payrollRecurringShare';
import type { EmployeeComponent, PayrollEmployee, PayrollPeriod } from './payrollTypes';

/** The run's components for one employee: the last-day reading plus the rows that ended inside employment, apportioned. */
export async function readRunComponents(
  employee: PayrollEmployee, companyId: string, period: PayrollPeriod, readDate: string,
): Promise<EmployeeComponent[]> {
  const read = await getEmployeeComponents(employee.id, companyId, readDate, period.start);
  const ended = await recurringEarningsEndedInPeriod(employee.id, companyId, periodBoundsOf(period).start, readDate);
  return apportionRecurringRows([...read, ...ended], employee, period);
}
