/**
 * The pay-run grid's refusals (master plan wave 3, R), through the real chain: a once-off the
 * run pays that a cell cannot show, a deduction larger than pay, an amount someone else
 * changed, a held row. Each must leave nothing behind (rule 9). Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import components from '../../pages/api/payroll/employees/[id]/components';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture, SALARY } from './payrun-period-inputs.helpers';
import type { Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, set, get, put, rows, line, header, preview, doApprove, call, addRow, recalculate } = fx;
const comp = state.comp;

beforeAll(fx.setUp);
beforeEach(fx.freshCompany);
afterEach(fx.dropCompany);
afterAll(fx.tearDown);

const amountsFor = async (component: string) => ((await get(state.nov)).body.data!.inputs.amounts as Array<{ componentId: string }>)
  .filter((a) => a.componentId === component);
const codes = (l: { validation_results: Array<{ code: string }> }) => l.validation_results.map((v) => v.code);

describe('a once-off the run pays but a cell cannot show', () => {
  it('overtime captured on the 15th through the employee page: the cell says so, and typing is refused instead of paying twice', async () => {
    const captured = await call(components as Route, 'POST', `/api/payroll/employees/${state.employee}/components`, state.employee, {
      body: { componentId: comp.overtime, amount: 2000, effectiveFrom: '2026-11-15', isRecurring: false },
    });
    expect(captured.statusCode, JSON.stringify(captured.body)).toBeLessThan(300);
    expect(await rows(comp.overtime!)).toMatchObject([{ from: '2026-11-15', to: '2026-11-30' }]);
    await recalculate(state.nov);
    expect((await line(state.nov)).gross).toBeCloseTo(SALARY + 2000, 2);

    expect(await amountsFor(comp.overtime!)).toEqual([{ employeeId: state.employee, componentId: comp.overtime, amount: null, conflict: true }]);
    const res = await set(state.nov, comp.overtime!, 2000);
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.message).toContain('Edit this on the employee page');
    expect(await rows(comp.overtime!)).toHaveLength(1);
    expect((await line(state.nov)).gross).toBeCloseTo(SALARY + 2000, 2);
  });

  it('refuses 409 when two rows match on the key, for an amount and for 0, and writes nothing', async () => {
    await addRow(comp.commission!, 400, '2026-11-01', '2026-11-30');
    await addRow(comp.commission!, 50, '2026-11-01', '2026-11-30');
    await recalculate(state.nov);
    const before = await line(state.nov);
    for (const amount of [999, 0]) {
      const res = await set(state.nov, comp.commission!, amount);
      expect(res.statusCode).toBe(409);
      expect(res.body.error?.message).toContain('Edit this on the employee page');
    }
    expect((await rows(comp.commission!)).map((r) => r.amount).sort((a, b) => a - b)).toEqual([50, 400]);
    expect((await line(state.nov)).gross).toBe(before.gross);
    expect(await amountsFor(comp.commission!)).toEqual([{ employeeId: state.employee, componentId: comp.commission, amount: null, conflict: true }]);
  });

  // The window is the reader's: for each row, the cell conflicts exactly when the run really pays it.
  // A row the run does not pay here cannot be doubled, so the cell stays free and blank.
  it.each([
    ['the 15th to month end', '2026-11-15', '2026-11-30'],
    ['a run of months ending here', '2026-10-01', '2026-11-30'],
    ['open-ended', '2026-11-10', null],
    ['from an earlier month, open-ended', '2026-01-01', null],
    ['the month, ending early', '2026-11-01', '2026-11-27'],
    ['the 1st to the 10th', '2026-11-01', '2026-11-10'],
    ['the 26th', '2026-11-26', '2026-11-26'],
    ['the 29th to month end', '2026-11-29', '2026-11-30'],
    ['last month', '2026-10-01', '2026-10-31'],
    ['next month', '2026-12-01', '2026-12-31'],
  ])('%s: conflicts exactly when the run pays it', async (_what, from, to) => {
    await addRow(comp.overtime!, 700, from, to);
    await recalculate(state.nov);
    const paid = Math.abs((await line(state.nov)).gross - (SALARY + 700)) < 0.005;
    const amounts = await amountsFor(comp.overtime!);
    expect(amounts.length === 1 && (amounts[0] as unknown as { conflict: boolean }).conflict).toBe(paid);
    expect((await set(state.nov, comp.overtime!, 300, state.employee, 0)).statusCode).toBe(paid ? 409 : 200);
    expect((await line(state.nov)).gross).toBeCloseTo(SALARY + (paid ? 700 : 300), 2);
  });

  it('the row exactly on the key is the cell, not a conflict', async () => {
    await addRow(comp.overtime!, 700, '2026-11-01', '2026-11-30');
    expect(await amountsFor(comp.overtime!)).toEqual([{ employeeId: state.employee, componentId: comp.overtime, amount: 700, conflict: false }]);
  });

  it('a recurring amount is no conflict, and is reported beside the cell', async () => {
    const salary = (await pool.query('SELECT id FROM payroll_components WHERE company_id = $1 AND sars_source_code = $2', [state.coA, '3601'])).rows[0]!.id;
    const data = (await get(state.nov)).body.data!;
    expect(data.inputs.amounts).toEqual([]);
    expect(data.inputs.recurring).toEqual([{ employeeId: state.employee, componentId: salary, amount: SALARY }]);
    expect((await set(state.nov, salary, 500)).statusCode).toBe(200);
    expect((await line(state.nov)).gross).toBeCloseTo(SALARY + 500, 2);
  });

  it('a recurring amount that ended before this month is not reported', async () => {
    await addRow(comp.commission!, 900, '2026-01-01', '2026-10-31', true);
    const { recurring } = (await get(state.nov)).body.data!.inputs as { recurring: Array<{ componentId: string }> };
    expect(recurring.filter((r) => r.componentId === comp.commission)).toEqual([]);
  });
});

describe('deductions larger than pay', () => {
  it('R30 000 of dues on R20 000 of salary is refused and leaves the row, the line and the run as they were', async () => {
    const [lineBefore, headerBefore] = [await line(state.nov), await header(state.nov)];
    const res = await set(state.nov, comp.union!, 30000);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error?.message).toContain("more than this employee's pay");
    expect(await rows(comp.union!)).toEqual([]);
    expect(await line(state.nov)).toEqual(lineBefore);
    expect(await header(state.nov)).toEqual(headerBefore);
  });

  it('dues of exactly the net are allowed, one cent more is not', async () => {
    const { net } = await line(state.nov);
    expect((await set(state.nov, comp.union!, net)).statusCode).toBe(200);
    expect((await line(state.nov)).net).toBe(0);
    expect((await set(state.nov, comp.union!, net + 0.01)).statusCode).toBe(400);
    expect(await rows(comp.union!)).toMatchObject([{ amount: net }]);
  });

  it('a once-off earning cut that takes the line below nil is refused too', async () => {
    await addRow(comp.union!, 25000, '2026-01-01', null, true);
    await addRow(comp.overtime!, 20000, '2026-11-01', '2026-11-30');
    await recalculate(state.nov);
    expect(codes(await line(state.nov))).not.toContain('DEDUCTIONS_EXCEED_PAY');
    expect((await set(state.nov, comp.overtime!, 0)).statusCode).toBe(400);
    expect(await rows(comp.overtime!)).toHaveLength(1);
  });

  it('an edit that only narrows a shortfall is allowed; the line stays flagged', async () => {
    await addRow(comp.union!, 30000, '2026-01-01', null, true);
    await recalculate(state.nov);
    expect((await set(state.nov, comp.overtime!, 1000)).statusCode).toBe(200);
    expect(codes(await line(state.nov))).toContain('DEDUCTIONS_EXCEED_PAY');
  });

  it("another employee's shortfall does not refuse this employee's edit", async () => {
    const second = await fx.addEmployee('W301-2');
    await addRow(comp.union!, 500, '2026-01-01', null, true, second);
    await recalculate(state.nov);
    expect(codes(await line(state.nov, second))).toContain('DEDUCTIONS_EXCEED_PAY');
    expect((await set(state.nov, comp.overtime!, 1000)).statusCode).toBe(200);
  });

  it('a run carrying one is refused by the approval gate, whatever wrote the deduction, and nothing posts', async () => {
    await addRow(comp.union!, 30000, '2026-01-01', null, true);
    await recalculate(state.nov);
    const { blocker, planHash } = (await preview(state.nov)).body.data!;
    expect(blocker).toMatchObject({ code: 'deductions_exceed_pay' });
    expect(blocker.detail).toContain('W301-1');
    const res = await doApprove(state.nov, planHash);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(await header(state.nov)).toMatchObject({ status: 'calculated', journal_entry_id: null });
  });

  it('a normal run has no such blocker, and the plan counts only those it pays', async () => {
    await fx.addEmployee('W301-2'); // on no pay: a line with nil net
    await recalculate(state.nov);
    const { blocker, plan } = (await preview(state.nov)).body.data!;
    expect(blocker).toBeNull();
    expect(plan).toMatchObject({ employeeCount: 2, paidEmployeeCount: 1 });
  });
});

describe('an amount someone else changed', () => {
  it('a PUT that expected another amount is refused 409 and writes nothing', async () => {
    await addRow(comp.overtime!, 700, '2026-11-01', '2026-11-30');
    await recalculate(state.nov);
    const res = await set(state.nov, comp.overtime!, 900, state.employee, 600);
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.message).toContain('Someone else changed this amount');
    expect(await rows(comp.overtime!)).toMatchObject([{ amount: 700 }]);
    expect((await line(state.nov)).gross).toBeCloseTo(SALARY + 700, 2);
  });

  it('a row added since the cell was empty is refused too, and so is one deleted since', async () => {
    await addRow(comp.overtime!, 700, '2026-11-01', '2026-11-30');
    expect((await set(state.nov, comp.overtime!, 900, state.employee, 0)).statusCode).toBe(409);
    await pool.query('DELETE FROM payroll_employee_components WHERE component_id = $1', [comp.overtime]);
    expect((await set(state.nov, comp.overtime!, 900, state.employee, 700)).statusCode).toBe(409);
    expect(await rows(comp.overtime!)).toEqual([]);
  });

  it('two first edits at once leave one row: the later one sees the other\'s amount', async () => {
    const both = await Promise.all([1, 2].map((n) => set(state.nov, comp.overtime!, n * 100, state.employee, 0)));
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await rows(comp.overtime!)).toHaveLength(1);
  });

  it.each([['missing', undefined], ['a string', '0']])('expectedAmount %s is refused 400', async (_what, expectedAmount) => {
    const res = await put(state.nov, { employeeId: state.employee, componentId: comp.overtime, amount: 100, expectedAmount });
    expect(res.statusCode).toBe(400);
    expect(await rows(comp.overtime!)).toEqual([]);
  });
});

describe('a held row', () => {
  it('a peer holding the once-off row gets a retryable refusal within the bound, not an open-ended wait', async () => {
    await addRow(comp.overtime!, 700, '2026-11-01', '2026-11-30');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM payroll_employee_components WHERE component_id = $1 FOR UPDATE', [comp.overtime]);
      const started = Date.now();
      const res = await set(state.nov, comp.overtime!, 900, state.employee, 700);
      expect(res.statusCode, JSON.stringify(res.body)).toBe(503);
      expect(Date.now() - started).toBeLessThan(9000);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await rows(comp.overtime!)).toMatchObject([{ amount: 700 }]);
  }, 15_000);
});
