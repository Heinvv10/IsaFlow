/**
 * W29 (wave 7 PRA): the run's reading of an employee's components with each recurring earning that starts or ends strictly
 * inside employment at its share of the period (payrollRecurringShare). The last-day reader (getEmployeeComponents) does
 * not read a recurring row that ended before the period's last day, so the earnings that ended inside employment in the
 * period are read here as well: recurring, an earning with a plain amount, ending from the period's first day to the day
 * before its last, before the employee's end date (a leaver's own row ending on their end date is the last-day reader's,
 * paid in full: ruling 19), not voided (payrollComponentService.recurringEarningsEndedInPeriod). The two reads are
 * disjoint: the last-day reader takes a recurring row ending before the last day only when it ends on the employee's end date.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getEmployeeComponents, recurringEarningsEndedInPeriod } from './payrollComponentService';
import { apportionRecurringRows, periodBoundsOf, type ShareEmployee } from './payrollRecurringShare';
import { payFrequencyOf } from './payrollFrequency';
import type { EmployeeComponent, PayFrequency, PayrollPeriod, UnsupportedValue } from './payrollTypes';

export type ShareReadEmployee = ShareEmployee & { id: string; payFrequency: PayFrequency | UnsupportedValue };

/** The run's components for one employee: the last-day reading plus the rows that ended inside employment, apportioned. */
export async function readRunComponents(
  employee: ShareReadEmployee, companyId: string, period: PayrollPeriod, readDate: string,
): Promise<EmployeeComponent[]> {
  const read = await getEmployeeComponents(employee.id, companyId, readDate, period.start);
  const ended = await recurringEarningsEndedInPeriod(employee.id, companyId, periodBoundsOf(period).start, readDate);
  return apportionRecurringRows([...read, ...ended], employee, period);
}

/**
 * The share facts of these employees (in this company): start, end and frequency, so a reader outside the run (the
 * pay-run grid, payrollRunPeriodInputsRead) reads their components exactly as the run does (review #1901 M5).
 */
export async function shareEmployeesOf(companyId: string, employeeIds: string[]): Promise<Map<string, ShareReadEmployee>> {
  if (employeeIds.length === 0) return new Map();
  const rows = (await sql`
    SELECT id, start_date, end_date, pay_frequency FROM payroll_employees
    WHERE company_id = ${companyId}::uuid AND id = ANY(${employeeIds}::uuid[])
  `) as DbRow[];
  const utc = (v: unknown) => new Date(`${fmtDate(v)}T00:00:00Z`);
  return new Map(rows.map((r) => [String(r.id), {
    id: String(r.id), startDate: utc(r.start_date), endDate: r.end_date ? utc(r.end_date) : null, payFrequency: payFrequencyOf(r.pay_frequency),
  }]));
}

