/**
 * HD: a refused hours body writes nothing (a 4xx commits): bad quantities, a client-sent amount, a monthly employee, a missing
 * rate, no hours component, stale expectations, a typed amount beside hours; the pre-HD plain amount replaced when named;
 * company scoping. Fixture: payrun-run-hours.helpers.ts.
 * Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
const noRate = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/modules/accounting/services/payroll/payrollEmployeeService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/accounting/services/payroll/payrollEmployeeService')>();
  return {
    ...actual,
    // Migration 967 CHECKs forbid an hourly employee with no rate, so the missing-rate branch is reached through the reader.
    listPayrollRunEmployees: async (...args: Parameters<typeof actual.listPayrollRunEmployees>) =>
      (await actual.listPayrollRunEmployees(...args)).map((e) => (noRate.on ? { ...e, hourlyRate: null } : e)),
  };
});

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { hoursFixture } from './payrun-run-hours.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const { fx, ctx, hours, makeHourly, makeDaily, stored, breakdownOf, codesOf, each } = hoursFixture(pool);
const { state, get, put, rows, line, preview, recalculate } = fx;
const basicId = () => ctx.basic;

beforeAll(fx.setUp);
beforeEach(async () => { noRate.on = false; await each(); });
afterEach(fx.dropCompany);
afterAll(fx.tearDown);

describe('a refused body writes nothing', () => {
  const unchanged = async () => {
    expect(await stored()).toEqual([]);
    expect((await rows(basicId()) as Array<{ is_recurring: boolean }>).filter((r) => !r.is_recurring)).toHaveLength(0);
  };
  it.each([['negative', -1], ['three decimals', 1.005], ['NaN', Number.NaN], ['a string', '160'], ['over a month of hours', 745], ['undefined', undefined]])(
    'quantity that is %s', async (_what, quantity) => {
      await makeHourly();
      const before = await line(state.nov);
      expect((await hours(state.nov, quantity)).statusCode).toBe(400);
      await unchanged();
      expect((await line(state.nov)).gross).toBe(before.gross);
    });

  it('a client-sent amount, a component, or no expectedQuantity beside the quantity is refused', async () => {
    await makeHourly();
    expect((await put(state.nov, { employeeId: state.employee, quantity: 160, expectedQuantity: null, amount: 1 })).statusCode).toBe(400);
    expect((await put(state.nov, { employeeId: state.employee, componentId: basicId(), quantity: 160, expectedQuantity: null })).statusCode).toBe(400);
    expect((await put(state.nov, { employeeId: state.employee, quantity: 160 })).statusCode).toBe(400);
    await unchanged();
  });

  it('a quantity that prices to nothing is refused (0.01 hours at R0.10 is a tenth of a cent)', async () => {
    await makeHourly(0.1);
    const res = await hours(state.nov, 0.01);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message).toContain('less than one cent');
    await unchanged();
  });

  it('a monthly employee has no hours', async () => {
    const res = await hours(state.nov, 160);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message).toContain('paid monthly');
    await unchanged();
  });

  it('a missing rate is a 400 naming it, before any write', async () => {
    await makeHourly();
    noRate.on = true;
    const res = await hours(state.nov, 160);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message).toContain('no rate per hour');
    noRate.on = false;
    await unchanged();
  });

  it('no active Basic Salary component: 400 naming it', async () => {
    await makeHourly();
    await pool.query('UPDATE payroll_components SET is_active = FALSE WHERE id = $1', [basicId()]);
    const res = await hours(state.nov, 160);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message).toContain('Basic Salary (3601)');
  });

  it('a stale expectedQuantity is 409 and the stored hours stay', async () => {
    await makeHourly();
    await hours(state.nov, 160);
    expect((await hours(state.nov, 100, 150)).statusCode).toBe(409);
    expect((await hours(state.nov, 100, null)).statusCode).toBe(409);
    expect(await stored()).toEqual([{ amount: 13680, quantity: 160, unit: 'hour' }]);
  });

  it('a typed amount beside hours is refused, and says what to do', async () => {
    await makeHourly();
    const none = await fx.set(state.nov, basicId(), 500);
    expect(none.statusCode).toBe(400);
    expect(none.body.error?.message).toContain('hours or days');
    await hours(state.nov, 160);
    expect((await fx.set(state.nov, basicId(), 999, state.employee, 13680)).statusCode).toBe(400);
    expect(await stored()).toEqual([{ amount: 13680, quantity: 160, unit: 'hour' }]);
  });
});

describe('a plain basicId()-pay amount from before hours existed (L2)', () => {
  it('is replaced by hours only when the request names that amount, else 409 saying what it is', async () => {
    await makeHourly();
    await fx.addRow(basicId(), 500, '2026-11-01', '2026-11-30');
    const unnamed = await hours(state.nov, 160);
    expect(unnamed.statusCode).toBe(409);
    expect(unnamed.body.error?.message).toContain('plain amount');
    expect((await hours(state.nov, 160, null, state.employee, { expectedAmount: 499 })).statusCode).toBe(409);
    expect(await stored()).toEqual([{ amount: 500, quantity: null, unit: null }]);
    const replaced = await hours(state.nov, 160, null, state.employee, { expectedAmount: 500 });
    expect(replaced.statusCode, JSON.stringify(replaced.body)).toBe(200);
    expect(await stored()).toEqual([{ amount: 13680, quantity: 160, unit: 'hour' }]);
  });
  it('null with the matching expectedAmount deletes that plain row (intended: hours cleared means the amount goes too); a wrong amount does not', async () => {
    await makeHourly();
    await fx.addRow(basicId(), 500, '2026-11-01', '2026-11-30');
    expect((await hours(state.nov, null, null, state.employee, { expectedAmount: 499 })).statusCode).toBe(409);
    expect(await stored()).toEqual([{ amount: 500, quantity: null, unit: null }]);
    expect((await hours(state.nov, null, null, state.employee, {})).statusCode).toBe(409);
    expect((await hours(state.nov, null, null, state.employee, { expectedAmount: 500 })).statusCode).toBe(200);
    expect(await stored()).toEqual([]);
  });
  it('the typed-amount refusal on that row says hours replace it', async () => {
    await makeHourly();
    await fx.addRow(basicId(), 500, '2026-11-01', '2026-11-30');
    const res = await fx.set(state.nov, basicId(), 600, state.employee, 500);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message).toContain('replaces this amount');
  });
});

describe('company scoping', () => {
  it('company B\'s run is 404 and an employee of B on A\'s run is 400; neither writes', async () => {
    await makeHourly();
    expect((await hours(state.runB, 160)).statusCode).toBe(404);
    expect((await hours(state.nov, 160, null, state.employeeB)).statusCode).toBe(400);
    expect(await stored()).toEqual([]);
    expect((await pool.query('SELECT 1 FROM payroll_employee_components WHERE employee_id = $1 AND quantity IS NOT NULL', [state.employeeB])).rowCount).toBe(0);
  });
});

