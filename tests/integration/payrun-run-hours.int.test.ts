/**
 * Hours and days per run (master plan wave 5, HD) through the real chain: PUT /api/payroll/runs/[id]/inputs with
 * { employeeId, quantity, expectedQuantity }. The amount is quantity x the employee's rate to the cent, worked out on
 * the server and stored with the quantity and unit on the run month's once-off Basic Salary row. 0 is an entered nil
 * (stored, counts as entered); null clears. Refusals: payrun-run-hours-refusals.int.test.ts; approval, recalculation and the
 * other-row rules: payrun-run-hours-gate.int.test.ts; the severance-only leaver: payrun-run-hours-leaver.int.test.ts.
 * Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { SALARY } from './payrun-period-inputs.helpers';
import { hoursFixture } from './payrun-run-hours.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const { fx, ctx, hours, makeHourly, makeDaily, stored, breakdownOf, codesOf, each } = hoursFixture(pool);
const { state, get, put, rows, line, preview, recalculate } = fx;
const basicId = () => ctx.basic;

beforeAll(fx.setUp);
beforeEach(each);
afterEach(fx.dropCompany);
afterAll(fx.tearDown);

describe('hourly: amount = quantity x rate, to the cent, on the server', () => {
  it('stores quantity, unit and the priced amount; the line is paid, taxed and netted on exactly that', async () => {
    await makeHourly(85.55);
    const res = await hours(state.nov, 173.33);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(await stored()).toEqual([{ amount: 14828.38, quantity: 173.33, unit: 'hour' }]);
    const l = await line(state.nov);
    expect(breakdownOf(l)).toMatchObject({ amount: 14828.38, quantity: 173.33, quantityUnit: 'hour', rate: 85.55 });
    // By hand, tax year 2027 (G21): 14 828.38 x 12 = 177 940.56 x 18% = 32 029.30 less the 17 820 primary rebate = 14 209.30,
    // /12 = 1 184.11, less the R376 medical credit (main member) = PAYE 808.11. UIF 1% = 148.28. SDL nil (under R500 000 a year).
    // Net 14 828.38 - 148.28 - 808.11 = 13 871.99.
    expect(l).toMatchObject({ gross: 14828.38, taxable: 14828.38, paye: 808.11, uif: 148.28, sdl: 0, net: 13871.99 });
    expect(res.body.data!.inputs.amounts).toEqual([
      { employeeId: state.employee, componentId: basicId(), amount: 14828.38, conflict: false, quantity: 173.33 },
    ]);
    expect(res.body.data!.inputs.hours).toEqual({ componentId: basicId(), problem: null, employees: [{ employeeId: state.employee, unit: 'hour', rate: 85.55 }] });
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

  it('a second entry replaces the row; null clears it and the line has no basicId() pay (and is flagged)', async () => {
    await makeHourly();
    await hours(state.nov, 160);
    expect((await stored())[0]!.amount).toBe(13680);
    expect((await hours(state.nov, 150, 160)).statusCode).toBe(200);
    expect(await stored()).toEqual([{ amount: 12825, quantity: 150, unit: 'hour' }]);
    expect((await hours(state.nov, null, 150)).statusCode).toBe(200);
    expect(await stored()).toEqual([]);
    const l = await line(state.nov);
    expect(l.gross).toBe(0);
    expect(codesOf(l)).toContain('HOURS_MISSING');
  });

  it('the hours survive a recalculation unchanged', async () => {
    await makeHourly();
    await hours(state.nov, 160);
    await recalculate(state.nov);
    expect(breakdownOf(await line(state.nov))).toMatchObject({ quantity: 160, quantityUnit: 'hour', rate: 85.5 });
  });
});

describe('an entered nil (M1)', () => {
  it('0 is stored as quantity 0, amount 0; the line is not flagged, has no rate, and the run approves', async () => {
    await makeHourly();
    const res = await hours(state.nov, 0);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(await stored()).toEqual([{ amount: 0, quantity: 0, unit: 'hour' }]);
    const l = await line(state.nov);
    expect(l.gross).toBe(0);
    expect(codesOf(l).filter((c) => c.startsWith('HOURS_'))).toEqual([]);
    expect(breakdownOf(l)).toMatchObject({ quantity: 0, quantityUnit: 'hour' });
    expect(breakdownOf(l)).not.toHaveProperty('rate');
    expect((await get(state.nov)).body.data!.inputs.amounts).toEqual([
      { employeeId: state.employee, componentId: basicId(), amount: 0, conflict: false, quantity: 0 },
    ]);
    const plan = (await preview(state.nov)).body.data!;
    expect(plan.blocker?.code).not.toMatch(/^hours_/);
  });
  it('a nil entry can be replaced by hours, and cleared with null', async () => {
    await makeHourly();
    await hours(state.nov, 0);
    expect((await hours(state.nov, 8, 0)).statusCode).toBe(200);
    expect(await stored()).toEqual([{ amount: 684, quantity: 8, unit: 'hour' }]);
    expect((await hours(state.nov, null, 8)).statusCode).toBe(200);
    expect(await stored()).toEqual([]);
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
    expect(codesOf(l)).toContain('HOURS_RATE_CHANGED');
  });
});

describe('ETI until ET apportions by hours (M2)', () => {
  it('80 hours at R30 for a 21-year-old claims no ETI and warns; 160 hours keeps it', async () => {
    await pool.query(`UPDATE payroll_employees SET date_of_birth = '2005-03-01', start_date = '2026-06-01', id_number = NULL WHERE id = $1`, [state.employee]);
    await makeHourly(30);
    await hours(state.nov, 80);
    const part = await line(state.nov);
    expect(part.gross).toBe(2400);
    expect(codesOf(part)).toContain('ETI_HOURS_APPORTIONMENT_PENDING');
    const eti = async () => Number((await pool.query('SELECT eti::float8 AS eti FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [state.nov, state.employee])).rows[0]!.eti);
    expect(await eti()).toBe(0);
    await hours(state.nov, 160, 80);
    expect(await eti()).toBeGreaterThan(0);
    expect(codesOf(await line(state.nov))).not.toContain('ETI_HOURS_APPORTIONMENT_PENDING');
  });
});

