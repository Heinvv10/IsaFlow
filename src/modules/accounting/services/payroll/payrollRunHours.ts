/**
 * Hours and days per run (master plan wave 5, HD). An hourly or daily employee is paid for what the run records:
 * the run's once-off Basic Salary (3601) row carries `quantity` and `quantity_unit` beside its amount
 * (migration 967), and the amount is quantity x the employee's rate, worked out on the server in whole cents
 * (hoursAmountCents). The breakdown keeps the quantity and the rate that was paid, so a later rate change cannot
 * rewrite what a line was costed at. A missing quantity is never read as nil: the line is flagged HOURS_MISSING
 * and the approval gate refuses it (payrollRunHoursGate).
 */
import { normaliseSarsCode } from './payeAnnualPayment';
import type { EmployeeComponent, PayrollEmployee, QuantityUnit, ValidationResult } from './payrollTypes';

/** The most a month can hold: 31 x 24 hours, 31 days. */
export const maxQuantity = (unit: QuantityUnit): number => (unit === 'hour' ? 744 : 31);

/** The unit an employee is paid in, or null for a monthly employee. */
export const unitOf = (employee: Pick<PayrollEmployee, 'payBasis'>): QuantityUnit | null =>
  employee.payBasis === 'hourly' ? 'hour' : employee.payBasis === 'daily' ? 'day' : null;

/** The rate per hour or per day, null for a monthly employee or one with no rate. */
export function rateOf(employee: Pick<PayrollEmployee, 'payBasis' | 'hourlyRate' | 'dailyRate'>): number | null {
  const rate = employee.payBasis === 'hourly' ? employee.hourlyRate : employee.payBasis === 'daily' ? employee.dailyRate : null;
  return rate == null ? null : Number(rate);
}

/** quantity x rate in cents: both taken to hundredths first, so the product is exact (no 0.1 x 3 float noise). */
export const hoursAmountCents = (quantity: number, rate: number): number =>
  Math.round((Math.round(quantity * 100) * Math.round(rate * 100)) / 100);

const isBasic = (c: EmployeeComponent) => c.component.componentType === 'earning' && normaliseSarsCode(c.component.sarsSourceCode) === '3601';

/** The rows that record this employee's hours or days in their own unit. */
const recorded = (employee: PayrollEmployee, components: EmployeeComponent[]) => {
  const unit = unitOf(employee);
  return components.filter((c) => unit != null && isBasic(c) && c.quantity != null && c.quantityUnit === unit);
};

/** Hours worked on the run, for ETI: the hours, or days x hours per day. Null when it cannot be told, never 0. */
export function runHoursOf(employee: PayrollEmployee, components: EmployeeComponent[]): number | null {
  const rows = recorded(employee, components);
  if (rows.length === 0) return null;
  const quantity = rows.reduce((sum, c) => sum + Number(c.quantity), 0);
  if (employee.payBasis === 'hourly') return quantity;
  return employee.hoursPerDay == null ? null : Math.round(quantity * Number(employee.hoursPerDay) * 100) / 100;
}

export function hoursValidation(employee: PayrollEmployee, components: EmployeeComponent[]): ValidationResult[] {
  const unit = unitOf(employee);
  if (unit == null) return [];
  const rows = recorded(employee, components);
  const name = `${employee.firstName} ${employee.lastName}`.trim();
  const noun = unit === 'hour' ? 'hours' : 'days';
  if (rows.length === 0) {
    return [{
      code: 'HOURS_MISSING', severity: 'error',
      message: `${name} is paid by the ${unit} but this run records no ${noun} for them, so nothing is paid for basic pay. Enter their ${noun} on the pay run.`,
    }];
  }
  const results: ValidationResult[] = [];
  const rate = rateOf(employee);
  const paid = rows.reduce((sum, c) => sum + Math.round(c.amount * 100), 0);
  const quantity = rows.reduce((sum, c) => sum + Number(c.quantity), 0);
  if (rate != null && paid !== hoursAmountCents(quantity, rate)) {
    results.push({
      code: 'HOURS_RATE_CHANGED', severity: 'warning',
      message: `${name}'s ${noun} were priced at an earlier rate than their current rate per ${unit}. The amount entered is paid; `
        + `enter the ${noun} again to price them at the current rate.`,
    });
  }
  if (components.some((c) => isBasic(c) && c.isRecurring === true && c.amount > 0)) {
    results.push({
      code: 'HOURS_WITH_RECURRING_BASIC', severity: 'warning',
      message: `${name} is paid by the ${unit} and also has a recurring Basic Salary, so basic pay is paid twice. Remove the recurring row if the ${noun} are the whole of it.`,
    });
  }
  return results;
}
