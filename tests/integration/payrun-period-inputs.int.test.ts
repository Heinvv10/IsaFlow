/**
 * PUT/GET /api/payroll/runs/[id]/inputs (master plan wave 3, R) through the real
 * chain: withAuth (cookie JWT, membership, app_user + RLS), withCsrf, the payroll
 * detail gate, and Postgres. The stored lines must follow the inputs with no
 * separate calculate, so approve can never read a stale calculation produced
 * through this path, and every refusal must leave nothing behind (rule 9).
 * The fixture is in payrun-period-inputs.helpers.ts: every test has its own company.
 * Refusals of each kind are in payrun-period-inputs-guards.int.test.ts.
 * Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const failCalculation = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/modules/accounting/services/payroll/payrollRunService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/accounting/services/payroll/payrollRunService')>();
  return {
    ...actual,
    calculatePayrollRun: async (runId: string, companyId: string) => {
      const summary = await actual.calculatePayrollRun(runId, companyId);
      if (failCalculation.on) throw new Error('calculation failed after the write');
      return summary;
    },
  };
});

import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture, SALARY } from './payrun-period-inputs.helpers';
import { calculatedRun, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, set, get, put, rows, line, preview, doApprove, call, viewer } = fx;
const comp = state.comp;

beforeAll(fx.setUp);
beforeEach(fx.freshCompany);
afterEach(fx.dropCompany);
afterAll(fx.tearDown);

describe('setting a once-off period amount', () => {
  it('raises the stored line with no separate calculate, and answers with the recalculated lines', async () => {
    const { nov, employee } = state;
    const before = await line(nov);
    const res = await set(nov, comp.overtime!, 1000);
    expect(res.statusCode).toBe(200);
    const after = await line(nov);
    expect(after.gross).toBeCloseTo(before.gross + 1000, 2);
    expect(res.body.data!.run.lines[0].grossPay).toBeCloseTo(after.gross, 2);
    expect(res.body.data!.run.lines[0].netPay).toBeCloseTo(after.net, 2);
    expect(res.body.data!.inputs.amounts).toEqual([{ employeeId: employee, componentId: comp.overtime, amount: 1000, conflict: false }]);
    expect((await fx.header(nov)).gross).toBeCloseTo(after.gross, 2);
  });

  it('writes one once-off row bounded by the run month', async () => {
    await set(state.nov, comp.overtime!, 1000);
    expect(await rows(comp.overtime!)).toMatchObject([{ amount: 1000, is_recurring: false, from: '2026-11-01', to: '2026-11-30' }]);
  });

  it('a second edit replaces the amount; it does not add', async () => {
    await set(state.nov, comp.overtime!, 1000);
    const [{ id }] = await rows(comp.overtime!) as [{ id: string }];
    expect((await set(state.nov, comp.overtime!, 2500)).statusCode).toBe(200);
    expect(await rows(comp.overtime!)).toMatchObject([{ id, amount: 2500 }]);
    expect((await line(state.nov)).gross).toBeCloseTo(SALARY + 2500, 2);
  });

  it('December does not see November\'s amount', async () => {
    await set(state.nov, comp.overtime!, 1000);
    const dec = await calculatedRun(call, 12);
    expect((await line(dec)).gross).toBeCloseTo(SALARY, 2);
  });

  it('edits the single matching row whoever wrote it', async () => {
    await fx.addRow(comp.commission!, 300, '2026-11-01', '2026-11-30');
    const [{ id }] = await rows(comp.commission!) as [{ id: string }];
    expect((await set(state.nov, comp.commission!, 400)).statusCode).toBe(200);
    expect(await rows(comp.commission!)).toMatchObject([{ id, amount: 400 }]);
  });

  it('amount 0 deletes the row and the line falls back', async () => {
    await set(state.nov, comp.overtime!, 1000);
    expect((await set(state.nov, comp.overtime!, 0)).statusCode).toBe(200);
    expect(await rows(comp.overtime!)).toEqual([]);
    expect((await line(state.nov)).gross).toBeCloseTo(SALARY, 2);
  });

  it('a deduction with no tax effect lowers net and leaves PAYE alone', async () => {
    const before = await line(state.nov);
    expect((await set(state.nov, comp.union!, 200)).statusCode).toBe(200);
    const after = await line(state.nov);
    expect(after.net).toBeCloseTo(before.net - 200, 2);
    expect(after.paye).toBe(before.paye);
  });
});

describe('lock order', () => {
  it('waits for the company approval lock before it holds the header, as calculate and approve do', async () => {
    const holder = await pool.connect();
    const key = `payroll_approval:${state.coA}`;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      const pending = set(state.nov, comp.overtime!, 0);
      await vi.waitFor(async () => {
        expect(await fx.lockWaiters(key)).toBe(1);
      }, { timeout: 4000, interval: 25 });
      // Taken with NOWAIT: a header held out of order would answer 55P03 here.
      await pool.query('SELECT 1 FROM payroll_run_headers WHERE id = $1 FOR UPDATE NOWAIT', [state.nov]);
      await holder.query('COMMIT');
      expect((await pending).statusCode).toBe(200);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
});

describe('what the grid may not touch', () => {
  it.each(['medical', 'provident', 'bonus', 'advance', 'loan', 'taxedDeduction', 'inactive', 'foreign'])(
    '%s is refused 400 and leaves no row', async (name) => {
      const res = await set(state.nov, comp[name]!, 100);
      expect(res.statusCode, JSON.stringify(res.body)).toBe(400);
      expect(await rows(comp[name]!)).toEqual([]);
    });

  it('offers only the editable components', async () => {
    const offered = (await get(state.nov)).body.data!.inputs.components.map((c: { name: string }) => c.name);
    expect(offered).toEqual(['Basic Salary', 'Commission', 'Overtime', 'Union dues']);
  });

  it.each([['a string', '1000'], ['negative', -1], ['three decimals', 1.005], ['too large', 1e13], ['missing', undefined], ['NaN', Number.NaN]])(
    'refuses an amount that is %s', async (_what, amount) => {
      expect((await set(state.nov, comp.overtime!, amount)).statusCode).toBe(400);
      expect(await rows(comp.overtime!)).toEqual([]);
    });

  it('company B\'s run is 404 and an employee of B on A\'s run is 400; neither writes', async () => {
    const { nov, runB, employeeB } = state;
    expect((await set(runB, comp.foreign!, 100, employeeB)).statusCode).toBe(404);
    expect((await set(runB, comp.overtime!, 100)).statusCode).toBe(404);
    expect((await set(nov, comp.overtime!, 100, employeeB)).statusCode).toBe(400);
    expect((await get(runB)).statusCode).toBe(404);
    expect(await rows(comp.foreign!, employeeB)).toEqual([]);
    expect(await rows(comp.overtime!, employeeB)).toEqual([]);
  });

  it('a viewer is 403', async () => {
    const body = { employeeId: state.employee, componentId: comp.overtime, amount: 1, expectedAmount: 0 };
    expect((await put(state.nov, body, { user: viewer })).statusCode).toBe(403);
    expect(await rows(comp.overtime!)).toEqual([]);
  });

  it('a tax year with no tables is refused before the write', async () => {
    const run = (await pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_month, period_year) VALUES ($1, 6, 2031) RETURNING id`, [state.coA])).rows[0]!.id;
    const res = await set(run, comp.overtime!, 100);
    expect(res.statusCode).toBe(400);
    expect(await rows(comp.overtime!)).toEqual([]);
  });

  it('a calculation failure after the write answers 500 and rolls the row back', async () => {
    failCalculation.on = true;
    try {
      expect((await set(state.nov, comp.overtime!, 100)).statusCode).toBe(500);
    } finally {
      failCalculation.on = false;
    }
    expect(await rows(comp.overtime!)).toEqual([]);
  });
});

describe('approval after an edit', () => {
  it('a preview taken before the edit is refused 409', async () => {
    const stale = (await preview(state.nov)).body.data!.planHash;
    expect((await set(state.nov, comp.overtime!, 1000)).statusCode).toBe(200);
    expect((await doApprove(state.nov, stale)).statusCode).toBe(409);
  });

  const approved = async () => {
    await set(state.nov, comp.overtime!, 1000);
    const res = await doApprove(state.nov, (await preview(state.nov)).body.data!.planHash);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    return res;
  };

  it('approve immediately after the edit posts the new figures', async () => {
    const res = await approved();
    expect((await line(state.nov)).gross).toBeCloseTo(SALARY + 1000, 2);
    const bank = (await pool.query(
      `SELECT l.credit::float8 AS credit FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
        WHERE l.journal_entry_id = $1 AND a.account_code = '1110'`, [res.body.data!.journalEntryId])).rows[0]!;
    expect(bank.credit).toBeCloseTo((await line(state.nov)).net, 2);
  });

  it('an approved run is refused 400 and gets no row', async () => {
    await approved();
    expect((await set(state.nov, comp.commission!, 100)).statusCode).toBe(400);
    expect(await rows(comp.commission!)).toEqual([]);
  });

  it('a reopened run whose journal is in force and has loan work is refused before the write', async () => {
    await approved();
    const { nov } = state;
    expect((await call(reopen as Route, 'POST', `/api/payroll/runs/${nov}/reopen`, nov, { body: { reason: 'R loan refusal' } })).statusCode).toBe(200);
    await fx.addLoan(1000);
    const res = await set(nov, comp.commission!, 100);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error?.message).toContain('Reverse the payroll journal first');
    expect(await rows(comp.commission!)).toEqual([]);
  });
});
