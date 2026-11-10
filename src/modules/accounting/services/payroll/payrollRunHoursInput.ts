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
import { formatMoney } from '@/lib/money/formatMoney';
import { listPayrollRunEmployees } from './payrollEmployeeService';
import { getEmployeeComponents } from './payrollComponentService';
import { payrollRunReadDate } from './payrollRunReadDate';
import type { ComponentChangeActor } from './payrollComponentAudit';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader, withBoundedLockWait } from './payrollRunLock';
import { hoursAmountCents, maxQuantity, rateOf, unitOf } from './payrollRunHours';
import { anchorOf, hoursComponentOf } from './payrollRunHoursRead';
import { PayrollRunInputRefusedError } from './payrollRunInputRefused';
import { lockPaidRows } from './payrollRunPeriodInputsRead';
import {
  assertRunEditable, CHANGED, CONFLICTING_ROWS, getRunInputs, listEditableComponents, type RunInputsState,
} from './payrollRunPeriodInputs';
import { writeRunRow } from './payrollRunRowWrite';

const MAX_AMOUNT_CENTS = 99_999_999_999_999; // NUMERIC(14,2)
const refuse = (message: string) => new PayrollRunInputRefusedError(400, message);
const hundredths = (n: number) => Math.round(n * 100);

/** What the caller says the cell held: a quantity (null: no row) and, for a plain amount it replaces, that amount. */
export interface HoursExpectation { quantity: number | null; amount?: number | null }

/**
 * `quantity` null clears the row; 0 is an entered nil (stored, amount 0, counts as entered). A plain once-off Basic Salary
 * amount of this month (not hours) is replaced only when `expected.amount` names it, the same check as an amount edit; with
 * `quantity` null and that amount named it is DELETED (the cell was emptied: the amount goes with it, as intended).
 * A monthly employee's stale hours row (kept from an earlier pay basis) can be cleared here, nothing else.
 */
export async function setRunHours(
  companyId: string, runId: string, employeeId: string, quantity: number | null, expected: HoursExpectation, actor: ComponentChangeActor,
): Promise<RunInputsState> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0 || Math.abs(quantity * 100 - hundredths(quantity)) > 1e-6)) {
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
  const editable = await listEditableComponents(companyId);
  // Anchored on the component the employee's existing hours row sits on (so a later second 3601 earning does not move it, and
  // an ambiguous company can still edit and clear what is there); the company's hours component only when there is none.
  const anchorNow = async () => anchorOf((await getEmployeeComponents(employeeId, companyId, payrollRunReadDate(period)))
    .filter((c) => c.quantity != null && editable.some((e) => e.id === c.component.id)).map((c) => c.component.id));
  const anchor = await anchorNow();
  if (anchor.duplicate) throw new PayrollRunInputRefusedError(409, `${name} has more than one row recording hours or days this month. Keep one on the employee page.`);
  const found = anchor.componentId ? { component: editable.find((e) => e.id === anchor.componentId)! } : hoursComponentOf(editable);
  const component = 'component' in found ? found.component : null;
  if (unit == null && quantity !== null) throw refuse(`${name} is paid monthly: there are no hours or days to enter. Clear any old hours with an empty entry.`);
  if (!component) throw refuse('problem' in found ? found.problem : 'No hours component.');
  const noun = unit === 'hour' ? 'hours' : 'days';
  let cents = 0;
  if (quantity !== null && unit != null) {
    if (quantity > maxQuantity(unit)) throw refuse(`A month holds at most ${maxQuantity(unit)} ${noun}.`);
    const rate = rateOf(employee);
    if (rate == null || rate <= 0) throw refuse(`${name} has no rate per ${unit}: set it on the employee page before entering their ${noun}.`);
    cents = hoursAmountCents(quantity, rate);
    if (quantity > 0 && cents === 0) throw refuse(`${quantity} ${noun} at ${rate} per ${unit} comes to less than one cent: enter more, or 0 for none.`);
    if (cents > MAX_AMOUNT_CENTS) throw refuse(`${quantity} ${noun} at that rate is more than a pay amount can hold.`);
  }

  const matches = await withBoundedLockWait(runId, (tx) => lockPaidRows(tx, companyId, employeeId, component.id, period));
  // Re-verified (the whole anchor: component AND duplicate) now that this component's rows are locked FOR UPDATE. The employee-component
  // writers (employee page, batch, MCP) take the company lock but NOT the approval or run-header locks held here, so this narrows the race
  // between reading the anchor and writing; it does not close it. A move after this point is caught by the next calculation
  // (HOURS_DUPLICATE / HOURS_UNIT_MISMATCH block approval).
  if (JSON.stringify(await anchorNow()) !== JSON.stringify(anchor)) throw new PayrollRunInputRefusedError(409, CHANGED);
  const row = matches[0];
  if (matches.length > 1 || (row && row.on_key !== true)) throw new PayrollRunInputRefusedError(409, CONFLICTING_ROWS);
  const plain = row != null && row.quantity == null;
  if (plain) {
    // Pre-HD basic pay typed as an amount: replaced by hours only when the caller names that amount (it saw it).
    if (expected.amount == null || hundredths(Number(row.amount)) !== hundredths(expected.amount)) {
      throw new PayrollRunInputRefusedError(409, `This month already pays ${formatMoney(Number(row.amount))} of basic pay as a plain amount for ${name}. `
        + 'Enter the hours again with that amount shown to replace it, or edit it on the employee page.');
    }
  } else if ((row ? hundredths(Number(row.quantity)) : null) !== (expected.quantity == null ? null : hundredths(expected.quantity))) {
    throw new PayrollRunInputRefusedError(409, CHANGED);
  }
  if (quantity === null && !row) return await readState(companyId, runId);

  await writeRunRow({
    companyId, runId, employeeId, componentId: component.id, componentType: 'earning', period, rowId: row ? String(row.id) : null,
    amount: cents / 100, clear: quantity === null, quantity: quantity === null || unit == null ? null : { value: quantity, unit }, actor,
  });
  log.info('Payroll run hours set', { companyId, runId, employeeId, unit }, 'payrollRunHoursInput');
  return await readState(companyId, runId);
}

async function readState(companyId: string, runId: string): Promise<RunInputsState> {
  const state = await getRunInputs(companyId, runId);
  if (!state) throw new Error('Payroll run vanished under its own lock');
  return state;
}
