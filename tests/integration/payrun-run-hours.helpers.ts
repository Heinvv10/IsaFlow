/**
 * Shared fixture of the hours-and-days suites (HD): payrun-period-inputs.helpers.ts plus an hourly or daily employee, the
 * hours request as the grid sends it, and what the row and the line hold. `ctx.basic` is the company's Basic Salary component,
 * set per test by `each`.
 */
import type { Pool } from 'pg';
import { inputsFixture } from './payrun-period-inputs.helpers';

export function hoursFixture(pool: Pool) {
  const fx = inputsFixture(pool);
  const { state, put, recalculate } = fx;
  const ctx = { basic: '' };
  const hours = (run: string, quantity: unknown, expectedQuantity: number | null = null, employeeId = state.employee, more: object = {}) =>
    put(run, { employeeId, quantity, expectedQuantity, ...more });
  const dropRecurringBasic = (employeeId = state.employee) =>
    pool.query('DELETE FROM payroll_employee_components WHERE employee_id = $1 AND component_id = $2 AND is_recurring', [employeeId, ctx.basic]);
  const makeHourly = async (rate = 85.5, employeeId = state.employee) => {
    await pool.query(
      `UPDATE payroll_employees SET pay_basis = 'hourly', hourly_rate = $2, hours_per_week = 40, hours_per_day = 8 WHERE id = $1`, [employeeId, rate]);
    await dropRecurringBasic(employeeId); // paid by the hour: no recurring salary beside it
    await recalculate(state.nov);
  };
  const makeDaily = async (rate = 640) => {
    await pool.query(`UPDATE payroll_employees SET pay_basis = 'daily', daily_rate = $2, hours_per_day = 8 WHERE id = $1`, [state.employee, rate]);
    await dropRecurringBasic();
    await recalculate(state.nov);
  };
  const stored = async () => (await pool.query(
    `SELECT amount::float8 AS amount, quantity::float8 AS quantity, quantity_unit AS unit FROM payroll_employee_components
      WHERE employee_id = $1 AND component_id = $2 AND NOT is_recurring`, [state.employee, ctx.basic])).rows;
  const breakdownOf = (l: { component_breakdown: Array<Record<string, unknown>> }) => l.component_breakdown.find((i) => i.componentId === ctx.basic);
  const codesOf = (l: { validation_results: Array<{ code: string }> }) => l.validation_results.map((v) => v.code);
  /** beforeEach: a fresh company A with a November run; ctx.basic is its Basic Salary. */
  const each = async () => {
    await fx.freshCompany();
    ctx.basic = (await pool.query('SELECT id FROM payroll_components WHERE company_id = $1 AND sars_source_code = $2', [state.coA, '3601'])).rows[0]!.id;
  };
  return { fx, ctx, hours, dropRecurringBasic, makeHourly, makeDaily, stored, breakdownOf, codesOf, each };
}
