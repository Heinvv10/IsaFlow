/**
 * Hours and days per run (master plan wave 5, HD) through the real chain: PUT /api/payroll/runs/[id]/inputs with
 * { employeeId, quantity, expectedQuantity }. The amount is quantity x the employee's rate to the cent, worked out on
 * the server and stored with the quantity and unit on the run month's once-off Basic Salary row. A refused body
 * writes nothing (a 4xx commits), and an hourly employee with no hours is refused at approval, never paid as nil.
 * The fixture is payrun-period-inputs.helpers.ts: every test has its own company A with one employee.
 * Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture, SALARY } from './payrun-period-inputs.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, get, put, rows, line, preview, recalculate } = fx;

let basic = '';
const hours = (run: string, quantity: unknown, expectedQuantity = 0, employeeId = state.employee) =>
  put(run, { employeeId, quantity, expectedQuantity });
const makeHourly = async (rate = 85.5, employeeId = state.employee) => {
  await pool.query(
    `UPDATE payroll_employees SET pay_basis = 'hourly', hourly_rate = $2, hours_per_week = 40, hours_per_day = 8 WHERE id = $1`, [employeeId, rate]);
  // Paid by the hour: no recurring salary beside it.
  await pool.query('DELETE FROM payroll_employee_components WHERE employee_id = $1 AND component_id = $2 AND is_recurring', [employeeId, basic]);
  await recalculate(state.nov);
};
const makeDaily = async (rate = 640) => {
  await pool.query(`UPDATE payroll_employees SET pay_basis = 'daily', daily_rate = $2, hours_per_day = 8 WHERE id = $1`, [state.employee, rate]);
  await pool.query('DELETE FROM payroll_employee_components WHERE employee_id = $1 AND component_id = $2 AND is_recurring', [state.employee, basic]);
  await recalculate(state.nov);
};
const stored = async () => (await pool.query(
  `SELECT amount::float8 AS amount, quantity::float8 AS quantity, quantity_unit AS unit FROM payroll_employee_components
    WHERE employee_id = $1 AND component_id = $2 AND NOT is_recurring`, [state.employee, basic])).rows;
const breakdownOf = (l: { component_breakdown: Array<Record<string, unknown>> }) => l.component_breakdown.find((i) => i.componentId === basic);

beforeAll(fx.setUp);
beforeEach(async () => {
  await fx.freshCompany();
  basic = (await pool.query('SELECT id FROM payroll_components WHERE company_id = $1 AND sars_source_code = $2', [state.coA, '3601'])).rows[0]!.id;
});
afterEach(fx.dropCompany);
afterAll(fx.tearDown);

describe('hourly: amount = quantity x rate, to the cent, on the server', () => {
  it('stores quantity, unit and the priced amount; the line is paid exactly that; the breakdown keeps the rate', async () => {
    await makeHourly(85.55);
    const res = await hours(state.nov, 173.33);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(await stored()).toEqual([{ amount: 14828.38, quantity: 173.33, unit: 'hour' }]);
    const l = await line(state.nov);
    expect(l.gross).toBeCloseTo(14828.38, 2);
    expect(breakdownOf(l)).toMatchObject({ amount: 14828.38, quantity: 173.33, quantityUnit: 'hour', rate: 85.55 });
    expect(res.body.data!.inputs.amounts).toEqual([
      { employeeId: state.employee, componentId: basic, amount: 14828.38, conflict: false, quantity: 173.33 },
    ]);
    expect(res.body.data!.inputs.hours).toEqual({ componentId: basic, employees: [{ employeeId: state.employee, unit: 'hour', rate: 85.55 }] });
  });

  it('prices 0.1 x 3 as 30 cents, with no float noise, and rounds a half cent up', async () => {
    await makeHourly(0.1);
    expect((await hours(state.nov, 3)).statusCode).toBe(200);
    expect((await stored())[0]!.amount).toBe(0.3);
    expect((await hours(state.nov, 0.5, 3)).statusCode).toBe(200); // 0.05 rand
    await pool.query('UPDATE payroll_employees SET hourly_rate = 0.5 WHERE id = $1', [state.employee]);
    expect((await hours(state.nov, 0.01, 0.5)).statusCode).toBe(200); // 0.005 rand rounds up to 0.01
    expect((await stored())[0]!.amount).toBe(0.01);
  });

  it('a second entry replaces the row; 0 clears it and the line pays no basic pay', async () => {
    await makeHourly();
    await hours(state.nov, 160);
    const [{ amount }] = await stored();
    expect(amount).toBe(13680);
    expect((await hours(state.nov, 150, 160)).statusCode).toBe(200);
    expect(await stored()).toEqual([{ amount: 12825, quantity: 150, unit: 'hour' }]);
    expect((await hours(state.nov, 0, 150)).statusCode).toBe(200);
    expect(await stored()).toEqual([]);
    expect((await line(state.nov)).gross).toBe(0);
  });

  it('the hours reach the line result and survive a recalculation unchanged', async () => {
    await makeHourly();
    await hours(state.nov, 160);
    await recalculate(state.nov);
    expect(breakdownOf(await line(state.nov))).toMatchObject({ quantity: 160, quantityUnit: 'hour', rate: 85.5 });
  });
});

describe('daily', () => {
  it('prices days at the daily rate and keeps the unit', async () => {
    await makeDaily(640);
    expect((await hours(state.nov, 20.5)).statusCode).toBe(200);
    expect(await stored()).toEqual([{ amount: 13120, quantity: 20.5, unit: 'day' }]);
    expect(breakdownOf(await line(state.nov))).toMatchObject({ quantity: 20.5, quantityUnit: 'day', rate: 640 });
  });
  it('a month holds at most 31 days', async () => {
    await makeDaily();
    expect((await hours(state.nov, 32)).statusCode).toBe(400);
    expect(await stored()).toEqual([]);
  });
});

describe('the rate is a snapshot', () => {
  it('a rate raised after entry changes neither the stored amount nor the line, and the line warns', async () => {
    await makeHourly(85.5);
    await hours(state.nov, 160);
    await pool.query('UPDATE payroll_employees SET hourly_rate = 90 WHERE id = $1', [state.employee]);
    await recalculate(state.nov);
    const l = await line(state.nov);
    expect(l.gross).toBeCloseTo(13680, 2);
    expect(breakdownOf(l)).toMatchObject({ amount: 13680, rate: 85.5 });
    expect(l.validation_results.map((v: { code: string }) => v.code)).toContain('HOURS_RATE_CHANGED');
  });
});

describe('a refused body writes nothing', () => {
  const unchanged = async () => {
    expect(await stored()).toEqual([]);
    expect((await rows(basic) as Array<{ is_recurring: boolean }>).filter((r) => !r.is_recurring)).toHaveLength(0);
  };
  it.each([['negative', -1], ['three decimals', 1.005], ['NaN', Number.NaN], ['a string', '160'], ['over a month of hours', 745]])(
    'quantity that is %s', async (_what, quantity) => {
      await makeHourly();
      const before = await line(state.nov);
      expect((await hours(state.nov, quantity)).statusCode).toBe(400);
      await unchanged();
      expect((await line(state.nov)).gross).toBe(before.gross);
    });

  it('a client-sent amount, or a component, beside the quantity is refused', async () => {
    await makeHourly();
    expect((await put(state.nov, { employeeId: state.employee, quantity: 160, expectedQuantity: 0, amount: 1 })).statusCode).toBe(400);
    expect((await put(state.nov, { employeeId: state.employee, componentId: basic, quantity: 160, expectedQuantity: 0 })).statusCode).toBe(400);
    expect((await put(state.nov, { employeeId: state.employee, quantity: 160 })).statusCode).toBe(400);
    await unchanged();
  });

  it('a monthly employee has no hours', async () => {
    const res = await hours(state.nov, 160);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message).toContain('paid monthly');
    await unchanged();
  });

  it('a missing rate is a 400 naming it, before any write (the CHECK is lifted for this test only)', async () => {
    await makeHourly();
    await pool.query('ALTER TABLE payroll_employees DROP CONSTRAINT payroll_employees_hourly_rate_required');
    try {
      await pool.query('UPDATE payroll_employees SET hourly_rate = NULL WHERE id = $1', [state.employee]);
      const res = await hours(state.nov, 160);
      expect(res.statusCode).toBe(400);
      expect(res.body.error?.message).toContain('no rate per hour');
      await unchanged();
    } finally {
      await pool.query('UPDATE payroll_employees SET hourly_rate = 85.5 WHERE id = $1', [state.employee]);
      await pool.query(`ALTER TABLE payroll_employees ADD CONSTRAINT payroll_employees_hourly_rate_required
        CHECK (pay_basis <> 'hourly' OR (hourly_rate IS NOT NULL AND hourly_rate > 0))`);
    }
  });

  it('no active Basic Salary component: 400 naming it', async () => {
    await makeHourly();
    await pool.query('UPDATE payroll_components SET is_active = FALSE WHERE id = $1', [basic]);
    const res = await hours(state.nov, 160);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message).toContain('Basic Salary (3601)');
  });

  it('a stale expectedQuantity is 409 and the stored hours stay', async () => {
    await makeHourly();
    await hours(state.nov, 160);
    expect((await hours(state.nov, 100, 150)).statusCode).toBe(409);
    expect(await stored()).toEqual([{ amount: 13680, quantity: 160, unit: 'hour' }]);
  });

  it('a plain once-off amount on the key is not overwritten by hours (409), and a typed amount beside hours is refused', async () => {
    await makeHourly();
    await fx.addRow(basic, 500, '2026-11-01', '2026-11-30');
    expect((await hours(state.nov, 160)).statusCode).toBe(409);
    expect(await stored()).toEqual([{ amount: 500, quantity: null, unit: null }]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id = $1 AND component_id = $2', [state.employee, basic]);
    expect((await fx.set(state.nov, basic, 500)).statusCode).toBe(400); // an hourly employee is paid in hours
    expect(await stored()).toEqual([]);
    await hours(state.nov, 160);
    expect((await fx.set(state.nov, basic, 999, state.employee, 13680)).statusCode).toBe(400); // and not by amount over their hours
    expect(await stored()).toEqual([{ amount: 13680, quantity: 160, unit: 'hour' }]);
  });
});

describe('company scoping', () => {
  it('company B\'s run is 404 and an employee of B on A\'s run is 400; neither writes', async () => {
    await makeHourly();
    expect((await hours(state.runB, 160)).statusCode).toBe(404);
    expect((await hours(state.nov, 160, 0, state.employeeB)).statusCode).toBe(400);
    expect(await stored()).toEqual([]);
    expect((await pool.query('SELECT 1 FROM payroll_employee_components WHERE employee_id = $1 AND quantity IS NOT NULL', [state.employeeB])).rowCount).toBe(0);
  });
});

describe('approval', () => {
  it('an hourly employee with no hours is flagged and the approval preview refuses, naming them; entering hours lifts it', async () => {
    await makeHourly();
    const l = await line(state.nov);
    expect(l.gross).toBe(0);
    expect(l.validation_results.map((v: { code: string }) => v.code)).toContain('HOURS_MISSING');
    const refused = (await preview(state.nov)).body.data!.blocker;
    expect(refused?.code).toBe('hours_missing');
    expect(refused?.detail).toContain('W301-1');
    await hours(state.nov, 160);
    expect((await preview(state.nov)).body.data!.blocker).toBeNull();
  });

  it('a monthly employee is never asked for hours', async () => {
    expect((await line(state.nov)).gross).toBeCloseTo(SALARY, 2);
    expect((await get(state.nov)).body.data!.inputs.hours).toEqual({ componentId: basic, employees: [] });
    expect((await preview(state.nov)).body.data!.blocker).toBeNull();
  });
});
