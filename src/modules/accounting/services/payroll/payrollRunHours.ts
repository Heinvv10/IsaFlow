/**
 * Hours and days per run (master plan wave 5, HD). An hourly or daily employee is paid for what the run records:
 * the run's once-off Basic Salary (3601) row carries `quantity` and `quantity_unit` beside its amount
 * (migration 967), and the amount is quantity x the employee's rate, worked out on the server in whole cents
 * (hoursAmountCents). The breakdown keeps the quantity and the rate that was paid, so a later rate change cannot
 * rewrite what a line was costed at. A missing quantity is never read as nil: the line is flagged HOURS_MISSING
 * and the approval gate refuses it (payrollRunHoursGate). A nil entry (0) is a quantity like any other: stored, amount 0.
 */
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
export const hoursAmountCents = (quantity: number, unitPrice: number): number =>
  Math.round((Math.round(quantity * 100) * Math.round(unitPrice * 100)) / 100);

const withQuantity = (c: EmployeeComponent) => c.quantity != null && c.quantityUnit != null;

/**
 * The hours component is identified by ID: the one the quantity rows sit on (setRunHours writes only to the company's one
 * hours component, payrollRunHoursRead.hoursComponentOf), never by SARS code. 3601 is SARS's general code, so other 3601
 * earnings (allowances, leave pay, corrections) are ordinary pay and are left alone.
 */
const quantityRows = (components: EmployeeComponent[]) => components.filter((c) => c.component.componentType === 'earning' && withQuantity(c));

/** The row that records this employee's hours or days in their own unit: exactly one counts, two are an error (hoursValidation). */
const recorded = (employee: PayrollEmployee, components: EmployeeComponent[]) => {
  const unit = unitOf(employee);
  return quantityRows(components).filter((c) => unit != null && c.quantityUnit === unit);
};

/**
 * Hours worked on the run, for ETI: the hours, or days x hours per day. Null when it cannot be told (nothing entered,
 * two rows, days with no hours per day), never 0. An entered nil is 0: it was said, not defaulted.
 */
export function runHoursOf(employee: PayrollEmployee, components: EmployeeComponent[]): number | null {
  const rows = recorded(employee, components);
  if (rows.length !== 1) return null;
  const quantity = Number(rows[0]!.quantity);
  if (employee.payBasis === 'hourly') return quantity;
  return employee.hoursPerDay == null ? null : Math.round(quantity * Number(employee.hoursPerDay) * 100) / 100;
}

/** ETI is apportioned by hours out of 160 (ETI Act s7(5)); until ET does that, a part-month hourly or daily line claims none. */
export const ETI_FULL_MONTH_HOURS = 160;
export const etiHoursPending = (employee: PayrollEmployee, hours: number | null): boolean =>
  unitOf(employee) != null && (hours == null || hours < ETI_FULL_MONTH_HOURS);

const err = (code: string, message: string): ValidationResult => ({ code, severity: 'error', message });

/**
 * What is wrong with the hours or days of this employee's line. Errors block approval (payrollRunHoursGate):
 * HOURS_MISSING, HOURS_UNIT_MISMATCH (a quantity row whose unit is not the employee's pay basis any more, e.g. hours left
 * after a move to monthly), HOURS_DUPLICATE (two rows record hours: never summed), HOURS_WITH_OTHER_BASIC (another
 * row on the hours component beside the hours would pay it twice). HOURS_RATE_CHANGED is a warning.
 */
export function hoursValidation(employee: PayrollEmployee, components: EmployeeComponent[]): ValidationResult[] {
  const unit = unitOf(employee);
  const name = `${employee.firstName} ${employee.lastName}`.trim();
  const results: ValidationResult[] = [];
  const stale = quantityRows(components).filter((c) => c.quantityUnit !== unit);
  if (stale.length > 0) {
    const held = stale.map((c) => `${c.quantity} ${c.quantityUnit}${c.quantity === 1 ? '' : 's'}`).join(', ');
    results.push(err('HOURS_UNIT_MISMATCH', `${name} is paid ${unit ? `by the ${unit}` : 'monthly'} but the run still holds ${held} of pay `
      + 'recorded for another pay basis. Edit or end that row on the employee page, or enter the hours again, then recalculate.'));
  }
  if (unit == null) return results;
  const noun = unit === 'hour' ? 'hours' : 'days';
  const rows = recorded(employee, components);
  if (rows.length === 0) {
    results.push(err('HOURS_MISSING', `${name} is paid by the ${unit} but this run records no ${noun} for them. Enter their ${noun} on the pay run (0 if none were worked).`));
    return results;
  }
  if (rows.length > 1) {
    results.push(err('HOURS_DUPLICATE', `${name} has ${rows.length} Basic Salary rows recording ${noun} this month, so their ${noun} cannot be told. Keep one on the employee page.`));
    return results;
  }
  const row = rows[0]!;
  const rate = rateOf(employee);
  // Cents only: a rate change that moves the total by under half a cent is not seen.
  if (rate != null && Math.round(row.amount * 100) !== hoursAmountCents(Number(row.quantity), rate)) {
    results.push({
      code: 'HOURS_RATE_CHANGED', severity: 'warning',
      message: `${name}'s ${noun} were priced at an earlier rate than their current rate per ${unit}. The amount entered is paid; `
        + `enter the ${noun} again to price them at the current rate.`,
    });
  }
  // Another row on THE SAME component (by id) would pay the hours component twice. Other components, 3601 or not, are fine.
  if (components.some((c) => !withQuantity(c) && c.amount !== 0 && c.component.id === row.component.id)) {
    results.push(err('HOURS_WITH_OTHER_BASIC', `${name} is paid by the ${unit} and also has another ${row.component.name} row this month (recurring, or a plain amount), `
      + `so ${row.component.name} is paid twice. End or remove the other row on the employee page, then recalculate.`));
  }
  return results;
}
