/**
 * PUT of one employee's hours or days on a pay run (master plan wave 5, HD): the run's once-off Basic Salary (3601)
 * row on the month's key takes `quantity`, `quantity_unit` and `amount = quantity x rate`, worked out here in whole
 * cents from the employee's rate, never sent by the client. 0 clears the row. Everything that can refuse does so
 * under the locks and before the first write (a 4xx commits): a monthly employee, a missing rate, a missing Basic
 * Salary component, a quantity out of range, an amount the column cannot hold. The calculation, the write and a
 * second calculation then share one savepoint (writeRunRow), as for any amount of the grid.
 */
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { log } from '@/lib/logger';
import { listPayrollRunEmployees } from './payrollEmployeeService';
import type { ComponentChangeActor } from './payrollComponentAudit';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader, withBoundedLockWait } from './payrollRunLock';
import { hoursAmountCents, maxQuantity, rateOf, unitOf } from './payrollRunHours';
import { basicSalaryOf } from './payrollRunHoursRead';
import { PayrollRunInputRefusedError } from './payrollRunInputRefused';
import { lockPaidRows } from './payrollRunPeriodInputsRead';
import {
  assertRunEditable, CHANGED, CONFLICTING_ROWS, getRunInputs, listEditableComponents, type RunInputsState,
} from './payrollRunPeriodInputs';
import { writeRunRow } from './payrollRunRowWrite';

const MAX_AMOUNT_CENTS = 99_999_999_999_999; // NUMERIC(14,2)
const refuse = (message: string) => new PayrollRunInputRefusedError(400, message);
const hundredths = (n: number) => Math.round(n * 100);

export async function setRunHours(
  companyId: string, runId: string, employeeId: string, quantity: number, expectedQuantity: number, actor: ComponentChangeActor,
): Promise<RunInputsState> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  if (!Number.isFinite(quantity) || quantity < 0 || Math.abs(quantity * 100 - hundredths(quantity)) > 1e-6) {
    throw refuse('Enter hours or days of zero or more, to two decimals.');
  }
  await lockCompanyPayrollApprovals(runId, companyId);
  const run = await lockPayrollRunHeader(runId, companyId);
  if (!run) throw new PayrollRunInputRefusedError(404, 'Payroll run not found');

  const period = { year: Number(run.period_year), month: Number(run.period_month) };
  await assertRunEditable(companyId, runId, run, period);
  const employee = (await listPayrollRunEmployees(companyId, period)).find((e) => e.id === employeeId);
  if (!employee) throw refuse('This employee is not on this run.');
  const name = `${employee.firstName} ${employee.lastName}`.trim();
  const unit = unitOf(employee);
  if (unit == null) throw refuse(`${name} is paid monthly: there are no hours or days to enter.`);
  const noun = unit === 'hour' ? 'hours' : 'days';
  if (quantity > maxQuantity(unit)) throw refuse(`A month holds at most ${maxQuantity(unit)} ${noun}.`);
  const rate = rateOf(employee);
  if (rate == null || rate <= 0) throw refuse(`${name} has no rate per ${unit}: set it on the employee page before entering their ${noun}.`);
  const component = basicSalaryOf(await listEditableComponents(companyId));
  if (!component) throw refuse('This company has no active taxable Basic Salary (3601) component to record hours or days on.');
  const cents = hoursAmountCents(quantity, rate);
  if (cents > MAX_AMOUNT_CENTS) throw refuse(`${quantity} ${noun} at that rate is more than a pay amount can hold.`);

  const matches = await withBoundedLockWait(runId, (tx) => lockPaidRows(tx, companyId, employeeId, component.id, period));
  const row = matches[0];
  if (matches.length > 1 || (row && row.on_key !== true)) throw new PayrollRunInputRefusedError(409, CONFLICTING_ROWS);
  // A plain amount on this month's key is not hours: writing over it would drop it unseen.
  if (row && row.quantity == null) throw new PayrollRunInputRefusedError(409, CONFLICTING_ROWS);
  if (hundredths(row ? Number(row.quantity) : 0) !== hundredths(expectedQuantity)) throw new PayrollRunInputRefusedError(409, CHANGED);

  await writeRunRow({
    companyId, runId, employeeId, componentId: component.id, componentType: 'earning', period, rowId: row ? String(row.id) : null,
    amount: cents / 100, quantity: quantity === 0 ? null : { value: quantity, unit }, actor,
  });
  log.info('Payroll run hours set', { companyId, runId, employeeId, unit }, 'payrollRunHoursInput');

  const state = await getRunInputs(companyId, runId);
  if (!state) throw new Error('Payroll run vanished under its own lock');
  return state;
}
