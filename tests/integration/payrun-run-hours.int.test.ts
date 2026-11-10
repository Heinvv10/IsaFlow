/**
 * Hours and days per run (master plan wave 5, HD) through the real chain: PUT /api/payroll/runs/[id]/inputs with
 * { employeeId, quantity, expectedQuantity }. The amount is quantity x the employee's rate to the cent, worked out on
 * the server and stored with the quantity and unit on the run month's once-off Basic Salary row. A refused body
 * writes nothing (a 4xx commits), and an hourly employee with no hours is refused at approval, never paid as nil.
 * 0 is an entered nil (stored, counts as entered); null clears. The fixture is payrun-period-inputs.helpers.ts: every
 * test has its own company A with one employee. The severance-only leaver: payrun-run-hours-leaver.int.test.ts.
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
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import { inputsFixture, SALARY } from './payrun-period-inputs.helpers';
import type { Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, get, put, rows, line, preview, recalculate } = fx;

let basic = '';
const hours = (run: string, quantity: unknown, expectedQuantity: number | null = null, employeeId = state.employee, more: object = {}) =>
  put(run, { employeeId, quantity, expectedQuantity, ...more });
const dropRecurringBasic = (employeeId = state.employee) =>
  pool.query('DELETE FROM payroll_employee_components WHERE employee_id = $1 AND component_id = $2 AND is_recurring', [employeeId, basic]);
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
    WHERE employee_id = $1 AND component_id = $2 AND NOT is_recurring`, [state.employee, basic])).rows;
const breakdownOf = (l: { component_breakdown: Array<Record<string, unknown>> }) => l.component_breakdown.find((i) => i.componentId === basic);
const codesOf = (l: { validation_results: Array<{ code: string }> }) => l.validation_results.map((v) => v.code);

beforeAll(fx.setUp);
beforeEach(async () => {
  noRate.on = false;
  await fx.freshCompany();
  basic = (await pool.query('SELECT id FROM payroll_components WHERE company_id = $1 AND sars_source_code = $2', [state.coA, '3601'])).rows[0]!.id;
});
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
      { employeeId: state.employee, componentId: basic, amount: 14828.38, conflict: false, quantity: 173.33 },
    ]);
    expect(res.body.data!.inputs.hours).toEqual({ componentId: basic, problem: null, employees: [{ employeeId: state.employee, unit: 'hour', rate: 85.55 }] });
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

  it('a second entry replaces the row; null clears it and the line has no basic pay (and is flagged)', async () => {
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
      { employeeId: state.employee, componentId: basic, amount: 0, conflict: false, quantity: 0 },
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

describe('a refused body writes nothing', () => {
  const unchanged = async () => {
    expect(await stored()).toEqual([]);
    expect((await rows(basic) as Array<{ is_recurring: boolean }>).filter((r) => !r.is_recurring)).toHaveLength(0);
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
    expect((await put(state.nov, { employeeId: state.employee, componentId: basic, quantity: 160, expectedQuantity: null })).statusCode).toBe(400);
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
    await pool.query('UPDATE payroll_components SET is_active = FALSE WHERE id = $1', [basic]);
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
    const none = await fx.set(state.nov, basic, 500);
    expect(none.statusCode).toBe(400);
    expect(none.body.error?.message).toContain('hours or days');
    await hours(state.nov, 160);
    expect((await fx.set(state.nov, basic, 999, state.employee, 13680)).statusCode).toBe(400);
    expect(await stored()).toEqual([{ amount: 13680, quantity: 160, unit: 'hour' }]);
  });
});

describe('a plain basic-pay amount from before hours existed (L2)', () => {
  it('is replaced by hours only when the request names that amount, else 409 saying what it is', async () => {
    await makeHourly();
    await fx.addRow(basic, 500, '2026-11-01', '2026-11-30');
    const unnamed = await hours(state.nov, 160);
    expect(unnamed.statusCode).toBe(409);
    expect(unnamed.body.error?.message).toContain('plain amount');
    expect((await hours(state.nov, 160, null, state.employee, { expectedAmount: 499 })).statusCode).toBe(409);
    expect(await stored()).toEqual([{ amount: 500, quantity: null, unit: null }]);
    const replaced = await hours(state.nov, 160, null, state.employee, { expectedAmount: 500 });
    expect(replaced.statusCode, JSON.stringify(replaced.body)).toBe(200);
    expect(await stored()).toEqual([{ amount: 13680, quantity: 160, unit: 'hour' }]);
  });
  it('the typed-amount refusal on that row says hours replace it', async () => {
    await makeHourly();
    await fx.addRow(basic, 500, '2026-11-01', '2026-11-30');
    const res = await fx.set(state.nov, basic, 600, state.employee, 500);
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

describe('approval', () => {
  it('an hourly employee with no hours is flagged and the approval preview refuses, naming them; entering hours lifts it', async () => {
    await makeHourly();
    const l = await line(state.nov);
    expect(l.gross).toBe(0);
    expect(codesOf(l)).toContain('HOURS_MISSING');
    const refused = (await preview(state.nov)).body.data!.blocker;
    expect(refused?.code).toBe('hours_missing');
    expect(refused?.detail).toContain('W301-1');
    await hours(state.nov, 160);
    expect((await preview(state.nov)).body.data!.blocker).toBeNull();
  });

  it('a monthly employee is never asked for hours', async () => {
    expect((await line(state.nov)).gross).toBeCloseTo(SALARY, 2);
    expect((await get(state.nov)).body.data!.inputs.hours).toEqual({ componentId: basic, problem: null, employees: [] });
    expect((await preview(state.nov)).body.data!.blocker).toBeNull();
  });

  it('a run approved with hours, then reopened with no hours, meets the refusal on re-approval (journal in force)', async () => {
    await makeHourly();
    await hours(state.nov, 160);
    const ok = await fx.doApprove(state.nov, (await preview(state.nov)).body.data!.planHash);
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect((await fx.header(state.nov)).journal_entry_id).not.toBeNull();
    // Reopened: the journal stays in force. The hours are then removed outside the grid (the employee page, a batch).
    expect((await fx.call(reopen as Route, 'POST', `/api/payroll/runs/${state.nov}/reopen`, state.nov, { body: { reason: 'HD re-approval test' } })).statusCode).toBe(200);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id = $1 AND component_id = $2 AND NOT is_recurring', [state.employee, basic]);
    await recalculate(state.nov);
    expect(codesOf(await line(state.nov))).toContain('HOURS_MISSING');
    expect((await preview(state.nov)).body.data!.blocker?.code).toBe('hours_missing');
  });
});

describe('a change of pay basis or rate after calculation (H1)', () => {
  it('hourly to monthly leaves hours beside a recurring salary: R15 000 + R14 834.25 is flagged, blocked, and the change forces a recalculation', async () => {
    await makeHourly();
    await hours(state.nov, 173.5);
    expect((await stored())[0]!.amount).toBe(14834.25);
    await pool.query(`UPDATE payroll_employees SET pay_basis = 'monthly' WHERE id = $1`, [state.employee]);
    await fx.addRow(basic, 15000, '2020-01-01', null, true);
    // Not recalculated yet: the approval gate sends the run back first (the terms changed after calculation).
    expect((await preview(state.nov)).body.data!.blocker?.code).toBe('components_changed_after_calculation');
    await recalculate(state.nov);
    const l = await line(state.nov);
    expect(l.gross).toBeCloseTo(29834.25, 2); // both are paid
    expect(codesOf(l)).toContain('HOURS_UNIT_MISMATCH');
    const blocked = (await preview(state.nov)).body.data!.blocker;
    expect(blocked?.code).toBe('hours_inconsistent');
    expect(blocked?.detail).toContain('monthly');
  });

  it('monthly to hourly with the salary still recurring: no hours is missing, and hours beside the salary pay twice', async () => {
    await pool.query(`UPDATE payroll_employees SET pay_basis = 'hourly', hourly_rate = 85.5, hours_per_week = 40, hours_per_day = 8 WHERE id = $1`, [state.employee]);
    expect((await preview(state.nov)).body.data!.blocker?.code).toBe('components_changed_after_calculation');
    await recalculate(state.nov);
    expect(codesOf(await line(state.nov))).toContain('HOURS_MISSING');
    expect((await preview(state.nov)).body.data!.blocker?.code).toBe('hours_missing');
    expect((await hours(state.nov, 160)).statusCode).toBe(200);
    expect(codesOf(await line(state.nov))).toContain('HOURS_WITH_OTHER_BASIC');
    expect((await preview(state.nov)).body.data!.blocker?.code).toBe('hours_inconsistent');
  });

  it('a rate change alone after calculation sends the run back for recalculation', async () => {
    await makeHourly();
    await hours(state.nov, 160);
    expect((await preview(state.nov)).body.data!.blocker).toBeNull();
    await pool.query('UPDATE payroll_employees SET hourly_rate = 90 WHERE id = $1', [state.employee]);
    expect((await preview(state.nov)).body.data!.blocker?.code).toBe('components_changed_after_calculation');
  });

  it('a monthly employee\'s stale hours row can be cleared from the grid, and the amount edit says why it is refused', async () => {
    await makeHourly();
    await hours(state.nov, 160);
    await pool.query(`UPDATE payroll_employees SET pay_basis = 'monthly' WHERE id = $1`, [state.employee]);
    const typed = await fx.set(state.nov, basic, 500, state.employee, 13680);
    expect(typed.statusCode).toBe(400);
    expect(typed.body.error?.message).toContain('another pay basis');
    expect((await hours(state.nov, 5)).statusCode).toBe(400);
    expect((await hours(state.nov, null, 160)).statusCode).toBe(200);
    expect(await stored()).toEqual([]);
  });
});

describe('another Basic Salary row beside the hours (H3)', () => {
  it('a recurring row (the employee page) is a blocking error', async () => {
    await makeHourly();
    await hours(state.nov, 160);
    await fx.addRow(basic, 5000, '2020-01-01', null, true);
    await recalculate(state.nov);
    expect(codesOf(await line(state.nov))).toContain('HOURS_WITH_OTHER_BASIC');
    expect((await preview(state.nov)).body.data!.blocker?.code).toBe('hours_inconsistent');
  });
  it('a once-off plain amount written outside the grid (employee page, MCP) on another day of the month is a blocking error', async () => {
    await makeHourly();
    await hours(state.nov, 160);
    await fx.addRow(basic, 700, '2026-11-15', '2026-11-30');
    await recalculate(state.nov);
    expect(codesOf(await line(state.nov))).toContain('HOURS_WITH_OTHER_BASIC');
    expect((await preview(state.nov)).body.data!.blocker?.code).toBe('hours_inconsistent');
  });
  it('two hours rows are an error, never a sum', async () => {
    await makeHourly();
    await hours(state.nov, 80);
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, quantity, quantity_unit, effective_from, effective_to, is_recurring)
       VALUES ($1, $2, 6840, 80, 'hour', '2026-11-15', '2026-11-30', FALSE)`, [state.employee, basic]);
    await recalculate(state.nov);
    const l = await line(state.nov);
    expect(codesOf(l)).toContain('HOURS_DUPLICATE');
    expect((await preview(state.nov)).body.data!.blocker?.code).toBe('hours_inconsistent');
    expect(await hours(state.nov, 90, 80).then((r) => r.statusCode)).toBe(409);
  });
});

describe('other 3601 earnings are ordinary pay, the hours component is found by id (M-1)', () => {
  it('160 h + a R500 shift allowance on another 3601 component pays R14 180 with no block; a -R500 correction is allowed too', async () => {
    await makeHourly();
    const shift = await fx.addComponent(state.coA, 'Shift allowance', '3601', 'earning', true);
    expect((await hours(state.nov, 160)).statusCode).toBe(200); // two 3601 components: the one named Basic Salary takes the hours
    expect(await stored()).toEqual([{ amount: 13680, quantity: 160, unit: 'hour' }]);
    await fx.addRow(shift, 500, '2026-11-01', '2026-11-30');
    await recalculate(state.nov);
    const paid = await line(state.nov);
    expect(paid.gross).toBe(14180);
    expect(codesOf(paid).filter((c) => c.startsWith('HOURS_'))).toEqual([]);
    expect((await preview(state.nov)).body.data!.blocker).toBeNull();
    await pool.query('UPDATE payroll_employee_components SET amount = -500 WHERE employee_id = $1 AND component_id = $2', [state.employee, shift]);
    await recalculate(state.nov);
    const corrected = await line(state.nov);
    expect(corrected.gross).toBe(13180);
    expect(codesOf(corrected).filter((c) => c.startsWith('HOURS_'))).toEqual([]);
    // But a second row on the hours component itself is still blocked.
    await fx.addRow(basic, 100, '2026-11-20', '2026-11-30');
    await recalculate(state.nov);
    expect(codesOf(await line(state.nov))).toContain('HOURS_WITH_OTHER_BASIC');
    expect((await preview(state.nov)).body.data!.blocker?.code).toBe('hours_inconsistent');
  });

  it('several 3601 earnings and none named Basic Salary: hours are refused 400, not first-matched', async () => {
    await makeHourly();
    await pool.query(`UPDATE payroll_components SET name = 'Salary A' WHERE id = $1`, [basic]);
    await fx.addComponent(state.coA, 'Salary B', '3601', 'earning', true);
    const res = await hours(state.nov, 160);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message).toContain('Salary A, Salary B');
    expect((await get(state.nov)).body.data!.inputs.hours).toMatchObject({ componentId: null });
    expect(await stored()).toEqual([]);
  });
});

describe('a line costed without the hours rules but stamped with the current version (H-1)', () => {
  it('an hourly line with no quantity and no HOURS_* result must be recalculated, not approved', async () => {
    await makeHourly();
    await hours(state.nov, 160);
    expect((await preview(state.nov)).body.data!.blocker).toBeNull();
    // What a build without HD would have stored: same version stamp, no quantity on the items, no hours result.
    await pool.query(
      `UPDATE payroll_run_lines SET component_breakdown = (SELECT COALESCE(jsonb_agg(i - 'quantity' - 'quantityUnit' - 'rate'), '[]'::jsonb)
         FROM jsonb_array_elements(component_breakdown) i), validation_results = '[]'::jsonb WHERE run_id = $1`, [state.nov]);
    const blocked = (await preview(state.nov)).body.data!.blocker;
    expect(blocked?.code).toBe('recalculate_required');
    expect(blocked?.detail).toContain('W301-1');
    await recalculate(state.nov);
    expect((await preview(state.nov)).body.data!.blocker).toBeNull();
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
