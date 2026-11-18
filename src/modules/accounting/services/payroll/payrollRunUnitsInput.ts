/**
 * The pay-run grid's overtime hours and travel km (wave 6 RI, migration 999t). Each is a once-off row on the run month's key,
 * as the hours of HD (payrollRunHoursInput.ts), priced here in whole cents, never sent by the client:
 *   - overtime: the company's one overtime (3607) earning, `quantity` hours, `quantity_unit` 'hour', `rate_multiplier` 1.5 or 2,
 *     amount = hours x the employee's hourly rate x the multiplier (payrollRunInputUnits.overtimeAmountCents). One row per multiplier.
 *   - travel: the company's one reimbursive travel (3703, else 3702) earning, `quantity` km, `quantity_unit` 'km',
 *     amount = km x the rate a km the employer reimburses. The calculation splits it at the prescribed rate (splitTravelRows).
 * The grid's amount cells and the HD hours ignore these rows (isRunInputUnitRow). Everything that can refuse does so under the
 * locks and before the first write (a 4xx commits); the write is writeRunRow's savepoint, as for any amount of the grid.
 */
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { log } from '@/lib/logger';
import { formatMoney } from '@/lib/money/formatMoney';
import type { ComponentChangeActor } from './payrollComponentAudit';
import { listPayrollRunEmployees } from './payrollEmployeeService';
import { hoursAmountCents } from './payrollRunHours';
import { OVERTIME_MULTIPLIERS, overtimeAmountCents, overtimeHourlyRate } from './payrollRunInputUnits';
import { PayrollRunInputRefusedError } from './payrollRunInputRefused';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader, withBoundedLockWait } from './payrollRunLock';
import { assertRunEditable, CHANGED, CONFLICTING_ROWS, getRunInputs, type RunInputsState } from './payrollRunPeriodInputs';
import { writeRunRow } from './payrollRunRowWrite';
import { kindOf, monthlyBasicOf, unitComponents, unitRows, type UnitKind } from './payrollRunUnitsRead';

const MAX_HOURS = 744;
const MAX_KM = 99_999.99; // NUMERIC(8,2)
const MAX_RATE_PER_KM = 100;
const refuse = (message: string) => new PayrollRunInputRefusedError(400, message);
const hundredths = (n: number) => Math.round(n * 100);
const twoDecimals = (n: number) => Number.isFinite(n) && n >= 0 && Math.abs(n * 100 - hundredths(n)) <= 1e-6;

/** What the cell last showed: the quantity (null: no row). */
export interface UnitEntry { kind: UnitKind; multiplier: number | null; quantity: number | null; ratePerKm: number | null; expectedQuantity: number | null }

/** Set, change or clear (quantity null) one employee's overtime hours at a multiplier, or their travel km at a rate a km. */
export async function setRunUnits(companyId: string, runId: string, employeeId: string, entry: UnitEntry, actor: ComponentChangeActor): Promise<RunInputsState> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  const { kind, multiplier, quantity, ratePerKm } = entry;
  const travel = kind === 'travel';
  if (travel ? multiplier !== null : !OVERTIME_MULTIPLIERS.includes(multiplier ?? NaN)) throw refuse(travel ? 'Travel km take no multiplier.' : 'Overtime is paid at 1.5 or 2 times the hourly rate.');
  if (quantity !== null && (!twoDecimals(quantity) || quantity > (travel ? MAX_KM : MAX_HOURS))) {
    throw refuse(travel ? `Enter km of zero or more, to two decimals, at most ${MAX_KM}.` : `Enter overtime hours of zero or more, to two decimals, at most ${MAX_HOURS}.`);
  }
  if (travel && quantity !== null && (ratePerKm == null || !twoDecimals(ratePerKm) || ratePerKm <= 0 || ratePerKm > MAX_RATE_PER_KM)) {
    throw refuse(`Enter the rate a km the employee is reimbursed, above 0 and at most ${formatMoney(MAX_RATE_PER_KM)}, to the cent.`);
  }
  await lockCompanyPayrollApprovals(runId, companyId);
  const run = await lockPayrollRunHeader(runId, companyId);
  if (!run) throw new PayrollRunInputRefusedError(404, 'Payroll run not found');
  const period = { year: Number(run.period_year), month: Number(run.period_month) };
  await assertRunEditable(companyId, runId, run, period);
  const employee = (await listPayrollRunEmployees(companyId, period)).find((e) => e.id === employeeId);
  if (!employee) throw refuse('This employee is not on this run.');
  const componentId = (await unitComponents(companyId))[kind];
  if (!componentId) {
    throw refuse(travel ? 'Add one active reimbursive travel earning (code 3703, or 3702) to record km on.' : 'Add one active overtime earning (code 3607) to record overtime hours on.');
  }
  let cents = 0;
  if (quantity !== null) {
    const rate = travel ? ratePerKm! : overtimeHourlyRate(employee, await monthlyBasicOf(companyId, employee, period));
    if (rate == null) throw refuse('Set the employee\'s hourly rate, or their hours a week and one earning named "Basic Salary" (when there are several 3601 earnings, name one "Basic Salary"), before entering overtime.');
    cents = travel ? hoursAmountCents(quantity, rate) : overtimeAmountCents(quantity, rate, multiplier!);
  }

  const rows = (await withBoundedLockWait(runId, (tx) => unitRows(tx, companyId, period, [employeeId], true)))
    .filter((r) => kindOf(r) === kind && (travel || Number(r.rate_multiplier) === multiplier));
  const row = rows[0];
  if (rows.length > 1 || (row && row.on_key !== true)) throw new PayrollRunInputRefusedError(409, CONFLICTING_ROWS);
  if ((row ? hundredths(Number(row.quantity)) : null) !== (entry.expectedQuantity == null ? null : hundredths(entry.expectedQuantity))) {
    throw new PayrollRunInputRefusedError(409, CHANGED);
  }
  if (quantity === null && !row) return await stateOf(companyId, runId);
  await writeRunRow({
    companyId, runId, employeeId, componentId, componentType: 'earning', period, rowId: row ? String(row.id) : null, amount: cents / 100,
    clear: quantity === null, quantity: quantity === null ? null : { value: quantity, unit: travel ? 'km' : 'hour' }, rateMultiplier: travel ? null : multiplier, actor,
  });
  log.info('Payroll run units set', { companyId, runId, employeeId, kind, multiplier }, 'payrollRunUnitsInput');
  return await stateOf(companyId, runId);
}

async function stateOf(companyId: string, runId: string): Promise<RunInputsState> {
  const state = await getRunInputs(companyId, runId);
  if (!state) throw new Error('Payroll run vanished under its own lock');
  return state;
}
