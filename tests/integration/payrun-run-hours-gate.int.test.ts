/**
 * HD: approval, recalculation and the rules for other rows. An hourly employee with no hours is refused at approval; a change of
 * pay basis or rate after calculation sends the run back; hours beside another row on the hours component, two hours rows or a
 * unit that no longer fits are blocking errors; other 3601 earnings are ordinary pay; a stale-stamped line is recalculated.
 * Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import { SALARY } from './payrun-period-inputs.helpers';
import type { Route } from './w3-01-payroll.helpers';
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
    expect((await get(state.nov)).body.data!.inputs.hours).toEqual({ componentId: basicId(), problem: null, duplicates: [], employees: [] });
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
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id = $1 AND component_id = $2 AND NOT is_recurring', [state.employee, basicId()]);
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
    await fx.addRow(basicId(), 15000, '2020-01-01', null, true);
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
    const typed = await fx.set(state.nov, basicId(), 500, state.employee, 13680);
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
    await fx.addRow(basicId(), 5000, '2020-01-01', null, true);
    await recalculate(state.nov);
    expect(codesOf(await line(state.nov))).toContain('HOURS_WITH_OTHER_BASIC');
    expect((await preview(state.nov)).body.data!.blocker?.code).toBe('hours_inconsistent');
  });
  it('a once-off plain amount written outside the grid (employee page, MCP) on another day of the month is a blocking error', async () => {
    await makeHourly();
    await hours(state.nov, 160);
    await fx.addRow(basicId(), 700, '2026-11-15', '2026-11-30');
    await recalculate(state.nov);
    expect(codesOf(await line(state.nov))).toContain('HOURS_WITH_OTHER_BASIC');
    expect((await preview(state.nov)).body.data!.blocker?.code).toBe('hours_inconsistent');
  });
  it('two hours rows are an error, never a sum', async () => {
    await makeHourly();
    await hours(state.nov, 80);
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, quantity, quantity_unit, effective_from, effective_to, is_recurring)
       VALUES ($1, $2, 6840, 80, 'hour', '2026-11-15', '2026-11-30', FALSE)`, [state.employee, basicId()]);
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
    await fx.addRow(basicId(), 100, '2026-11-20', '2026-11-30');
    await recalculate(state.nov);
    expect(codesOf(await line(state.nov))).toContain('HOURS_WITH_OTHER_BASIC');
    expect((await preview(state.nov)).body.data!.blocker?.code).toBe('hours_inconsistent');
  });

  it('several 3601 earnings and none named Basic Salary: hours are refused 400, not first-matched', async () => {
    await makeHourly();
    await pool.query(`UPDATE payroll_components SET name = 'Salary A' WHERE id = $1`, [basicId()]);
    await fx.addComponent(state.coA, 'Salary B', '3601', 'earning', true);
    const res = await hours(state.nov, 160);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message).toContain('Salary A, Salary B');
    expect((await get(state.nov)).body.data!.inputs.hours).toMatchObject({ componentId: null });
    expect(await stored()).toEqual([]);
  });
});

describe('hours stay on the component they were entered on (round 3 L1)', () => {
  const rowComponent = async () => (await pool.query(
    'SELECT component_id FROM payroll_employee_components WHERE employee_id = $1 AND quantity IS NOT NULL', [state.employee])).rows.map((r) => r.component_id);

  it('hours on "Wages", then a "Basic Salary" 3601 is added: they stay on Wages, editable and clearable; with none left, new hours go to Basic Salary', async () => {
    await makeHourly();
    await pool.query(`UPDATE payroll_components SET name = 'Wages' WHERE id = $1`, [basicId()]);
    expect((await hours(state.nov, 160)).statusCode).toBe(200);
    const salary = await fx.addComponent(state.coA, 'Basic Salary', '3601', 'earning', true);
    const state1 = (await get(state.nov)).body.data!.inputs.hours;
    expect(state1.componentId).toBe(salary); // the company's hours component is now the one named Basic Salary...
    expect(state1.employees[0].componentId).toBe(basicId()); // ...but this employee's hours are where they were entered
    expect((await hours(state.nov, 150, 160)).statusCode).toBe(200);
    expect(await rowComponent()).toEqual([basicId()]);
    expect((await hours(state.nov, null, 150)).statusCode).toBe(200);
    expect(await rowComponent()).toEqual([]);
    expect((await hours(state.nov, 120)).statusCode).toBe(200);
    expect(await rowComponent()).toEqual([salary]);
  });

  it('in an ambiguous company (two 3601 earnings, none named Basic Salary) existing hours can be cleared and edited, and nothing new is entered', async () => {
    await makeHourly();
    await pool.query(`UPDATE payroll_components SET name = 'Salary A' WHERE id = $1`, [basicId()]);
    expect((await hours(state.nov, 160)).statusCode).toBe(200);
    await fx.addComponent(state.coA, 'Salary B', '3601', 'earning', true);
    expect((await get(state.nov)).body.data!.inputs.hours).toMatchObject({ componentId: null, employees: [{ componentId: basicId() }] });
    expect((await hours(state.nov, 100, 160)).statusCode).toBe(200);
    expect((await hours(state.nov, null, 100)).statusCode).toBe(200);
    const refused = await hours(state.nov, 50);
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error?.message).toContain('Salary A, Salary B');
    expect(await rowComponent()).toEqual([]);
  });

  it('two quantity rows on two components: the grid state and the write agree (duplicate, lowest id), the write is 409 and the line is blocked', async () => {
    await makeHourly();
    const other = await fx.addComponent(state.coA, 'Wages', '3601', 'earning', true);
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, quantity, quantity_unit, effective_from, effective_to, is_recurring)
       VALUES ($1, $2, 6840, 80, 'hour', '2026-11-01', '2026-11-30', FALSE), ($1, $3, 6840, 80, 'hour', '2026-11-01', '2026-11-30', FALSE)`,
      [state.employee, basicId(), other]);
    await recalculate(state.nov);
    const shown = (await get(state.nov)).body.data!.inputs.hours;
    expect(shown.duplicates).toEqual([state.employee]);
    expect(shown.employees[0]).toMatchObject({ componentId: [basicId(), other].sort()[0] });
    const refused = await hours(state.nov, 90, 80);
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error?.message).toContain('more than one row');
    const l = await line(state.nov);
    expect(codesOf(l)).toContain('HOURS_DUPLICATE');
    expect(l.validation_results.find((v: { code: string }) => v.code === 'HOURS_DUPLICATE').message).toContain('Basic Salary and Wages');
  });

  it('the grid and the write count the same rows: two once-off rows on ONE component, and a recurring row on A plus a once-off on B', async () => {
    await makeHourly();
    const insert = (component: string, from: string, to: string | null, recurring: boolean) => pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, quantity, quantity_unit, effective_from, effective_to, is_recurring)
       VALUES ($1, $2, 6840, 80, 'hour', $3, $4, $5)`, [state.employee, component, from, to, recurring]);
    // Two once-off rows on the SAME component: the grid cell is a conflict (quantity nulled), yet the state still says duplicate.
    await insert(basicId(), '2026-11-01', '2026-11-30', false);
    await insert(basicId(), '2026-11-01', '2026-11-30', false);
    expect((await get(state.nov)).body.data!.inputs.hours.duplicates).toEqual([state.employee]);
    expect((await hours(state.nov, 90, 80)).statusCode).toBe(409);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id = $1 AND quantity IS NOT NULL', [state.employee]);
    expect((await get(state.nov)).body.data!.inputs.hours.duplicates).toEqual([]);
    // A recurring quantity row on A plus a once-off on B: both readers see two rows.
    const other = await fx.addComponent(state.coA, 'Wages', '3601', 'earning', true);
    await insert(basicId(), '2020-01-01', null, true);
    await insert(other, '2026-11-01', '2026-11-30', false);
    expect((await get(state.nov)).body.data!.inputs.hours.duplicates).toEqual([state.employee]);
    expect((await hours(state.nov, 90, 80)).statusCode).toBe(409);
  });

  it('a monthly employee with two stale hours rows is listed as a duplicate too (the grid shows the way out)', async () => {
    const other = await fx.addComponent(state.coA, 'Wages', '3601', 'earning', true);
    for (const component of [basicId(), other]) {
      await pool.query(
        `INSERT INTO payroll_employee_components (employee_id, component_id, amount, quantity, quantity_unit, effective_from, effective_to, is_recurring)
         VALUES ($1, $2, 100, 8, 'hour', '2026-11-01', '2026-11-30', FALSE)`, [state.employee, component]);
    }
    const hoursState = (await get(state.nov)).body.data!.inputs.hours;
    expect(hoursState.duplicates).toEqual([state.employee]);
    expect(hoursState.employees).toEqual([]);
  });

  it('a recurring 3601 on another component beside the hours is a warning, not a block (a possible double salary)', async () => {
    await makeHourly();
    const fixed = await fx.addComponent(state.coA, 'Fixed allowance', '3601', 'earning', true);
    await hours(state.nov, 160);
    await fx.addRow(fixed, 1000, '2020-01-01', null, true);
    await recalculate(state.nov);
    const l = await line(state.nov);
    expect(codesOf(l)).toContain('HOURS_WITH_RECURRING_3601');
    expect(l.validation_results.find((v: { code: string }) => v.code === 'HOURS_WITH_RECURRING_3601').severity).toBe('warning');
    expect(l.gross).toBe(14680);
    expect((await preview(state.nov)).body.data!.blocker).toBeNull();
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

