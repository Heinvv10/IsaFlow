/**
 * PUT/GET /api/payroll/runs/[id]/inputs (master plan wave 3, R) through the real
 * chain: withAuth (cookie JWT, membership, app_user + RLS), withCsrf, the payroll
 * detail gate, and Postgres. The stored lines must follow the inputs with no
 * separate calculate, so approve can never read a stale calculation produced
 * through this path, and every refusal must leave nothing behind (rule 9).
 *
 * The admin belongs to A and B with A active, so company B's run is kept out by
 * the service asking with A's company id, not by RLS membership.
 * Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';

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

import inputs from '../../pages/api/payroll/runs/[id]/inputs';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const [coA, coB, admin, viewer] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: admin, company: coA });
const SALARY = 20000;
const loan = crypto.randomUUID();

let employee = '';
let employeeB = '';
let nov = '';
let runB = '';
const comp: Record<string, string> = {};

const url = (id: string) => `/api/payroll/runs/${id}/inputs`;
const put = (run: string, body: unknown, opts: { user?: string } = {}) => call(inputs as Route, 'PUT', url(run), run, { ...opts, body });
const get = (run: string) => call(inputs as Route, 'GET', url(run), run);
const set = (run: string, component: string, amount: unknown, employeeId = employee) =>
  put(run, { employeeId, componentId: component, amount });
const rows = async (component: string, employeeId = employee) => (await pool.query(
  `SELECT id, amount::float8 AS amount, is_recurring, effective_from::text AS "from", effective_to::text AS "to"
     FROM payroll_employee_components WHERE employee_id = $1 AND component_id = $2`, [employeeId, component])).rows;
const line = async (run: string) => (await pool.query(
  'SELECT gross_pay::float8 AS gross, paye::float8 AS paye, net_pay::float8 AS net FROM payroll_run_lines WHERE run_id = $1', [run])).rows[0]!;
const preview = (id: string) => call(journalPlan as Route, 'GET', `/api/payroll/runs/${id}/journal-plan`, id);
const doApprove = (id: string, expectedPlanHash: unknown) =>
  call(approve as Route, 'POST', `/api/payroll/runs/${id}/approve`, id, { body: { expectedPlanHash } });
const addComponent = async (company: string, name: string, code: string, type: string, taxable: boolean, active = true) => (await pool.query(
  `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable, is_active)
   VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [company, name, code, type, taxable, active])).rows[0]!.id as string;

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [coA, 'R inputs A', coB, 'R inputs B']);
  await seedPayrollCompany(pool, coA, SALARY);
  await seedPayrollCompany(pool, coB, SALARY);
  employee = (await pool.query('SELECT id FROM payroll_employees WHERE company_id = $1', [coA])).rows[0]!.id;
  employeeB = (await pool.query('SELECT id FROM payroll_employees WHERE company_id = $1', [coB])).rows[0]!.id;
  await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
     VALUES ($1, '2175', 'R deductions', 'liability', 'credit', 1)`, [coA]);
  for (const [id, email, role] of [[admin, 'a', 'admin'], [viewer, 'v', 'viewer']] as const) {
    await pool.query('INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, $3, true)', [id, `${email}-${id}@test.local`, role]);
    tokens[id] = await new SignJWT({ sub: id, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }
  await pool.query(
    `INSERT INTO company_users (company_id, user_id, role, is_default)
     VALUES ($1, $3, 'admin', true), ($2, $3, 'admin', false), ($1, $4, 'viewer', true)`, [coA, coB, admin, viewer]);
  comp.overtime = await addComponent(coA, 'Overtime', '3607', 'earning', true);
  comp.commission = await addComponent(coA, 'Commission', '3606', 'earning', true);
  comp.union = await addComponent(coA, 'Union dues', 'UNION', 'deduction', false);
  comp.medical = await addComponent(coA, 'Medical Aid', '4005', 'deduction', false);
  comp.provident = await addComponent(coA, 'Provident Fund', '4001', 'deduction', false);
  comp.bonus = await addComponent(coA, 'Annual Bonus', '3605', 'earning', true);
  comp.advance = await addComponent(coA, 'Salary Advance', '3907', 'deduction', false);
  comp.loan = await addComponent(coA, 'Loan repayment', 'LOAN', 'deduction', false);
  comp.taxedDeduction = await addComponent(coA, 'Salary sacrifice', 'SACR', 'deduction', true);
  comp.inactive = await addComponent(coA, 'Old overtime', '3607', 'earning', true, false);
  comp.foreign = await addComponent(coB, 'Overtime B', '3607', 'earning', true);
  nov = await calculatedRun(call, 11);
  runB = await calculatedRun(call, 11, { company: coB });
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_loan_payments WHERE loan_id = $1', [loan]);
    await pool.query('DELETE FROM payroll_loan_schedule WHERE loan_id = $1', [loan]);
    await pool.query('DELETE FROM payroll_loans WHERE id = $1', [loan]);
    await cleanPayrollCompanies(pool, [coA, coB]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, viewer]]);
  } finally {
    await pool.end();
  }
});

describe('setting a once-off period amount', () => {
  it('raises the stored line with no separate calculate, and answers with the recalculated lines', async () => {
    const before = await line(nov);
    const res = await set(nov, comp.overtime!, 1000);
    expect(res.statusCode).toBe(200);
    const after = await line(nov);
    expect(after.gross).toBeCloseTo(before.gross + 1000, 2);
    expect(res.body.data!.run.lines[0].grossPay).toBeCloseTo(after.gross, 2);
    expect(res.body.data!.run.lines[0].netPay).toBeCloseTo(after.net, 2);
    expect(res.body.data!.inputs.amounts).toEqual([{ employeeId: employee, componentId: comp.overtime, amount: 1000, conflict: false }]);
    expect((await pool.query('SELECT total_gross::float8 AS g FROM payroll_run_headers WHERE id = $1', [nov])).rows[0]!.g).toBeCloseTo(after.gross, 2);
  });

  it('writes one once-off row bounded by the run month', async () => {
    expect(await rows(comp.overtime!)).toMatchObject([{ amount: 1000, is_recurring: false, from: '2026-11-01', to: '2026-11-30' }]);
  });

  it('a second edit replaces the amount; it does not add', async () => {
    const [{ id }] = await rows(comp.overtime!) as [{ id: string }];
    expect((await set(nov, comp.overtime!, 2500)).statusCode).toBe(200);
    expect(await rows(comp.overtime!)).toMatchObject([{ id, amount: 2500 }]);
    expect((await line(nov)).gross).toBeCloseTo(SALARY + 2500, 2);
  });

  it('December does not see November\'s amount', async () => {
    const dec = await calculatedRun(call, 12);
    expect((await line(dec)).gross).toBeCloseTo(SALARY, 2);
  });

  it('edits the single matching row whoever wrote it', async () => {
    const written = (await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, is_recurring)
       VALUES ($1, $2, 300, '2026-11-01', '2026-11-30', false) RETURNING id`, [employee, comp.commission])).rows[0]!.id;
    expect((await set(nov, comp.commission!, 400)).statusCode).toBe(200);
    expect(await rows(comp.commission!)).toMatchObject([{ id: written, amount: 400 }]);
  });

  it('refuses 409 when two rows match, for an amount and for 0, and writes nothing', async () => {
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, is_recurring)
       VALUES ($1, $2, 50, '2026-11-01', '2026-11-30', false)`, [employee, comp.commission]);
    const before = await line(nov);
    for (const amount of [999, 0]) {
      const res = await set(nov, comp.commission!, amount);
      expect(res.statusCode).toBe(409);
      expect(res.body.error?.message).toContain('Edit this on the employee page');
    }
    expect((await rows(comp.commission!)).map((r) => r.amount).sort((a, b) => a - b)).toEqual([50, 400]);
    expect((await line(nov)).gross).toBe(before.gross);
    expect((await get(nov)).body.data!.inputs.amounts)
      .toContainEqual({ employeeId: employee, componentId: comp.commission, amount: null, conflict: true });
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id = $1 AND component_id = $2', [employee, comp.commission]);
  });

  it('amount 0 deletes the row and the line falls back', async () => {
    expect((await set(nov, comp.overtime!, 0)).statusCode).toBe(200);
    expect(await rows(comp.overtime!)).toEqual([]);
    expect((await line(nov)).gross).toBeCloseTo(SALARY, 2);
  });

  it('a deduction with no tax effect lowers net and leaves PAYE alone', async () => {
    const before = await line(nov);
    expect((await set(nov, comp.union!, 200)).statusCode).toBe(200);
    const after = await line(nov);
    expect(after.net).toBeCloseTo(before.net - 200, 2);
    expect(after.paye).toBe(before.paye);
    expect((await set(nov, comp.union!, 0)).statusCode).toBe(200);
  });

  it('two first edits at once leave one row', async () => {
    const both = await Promise.all([set(nov, comp.overtime!, 100), set(nov, comp.overtime!, 200)]);
    expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await rows(comp.overtime!)).toHaveLength(1);
    expect((await set(nov, comp.overtime!, 0)).statusCode).toBe(200);
  });
});

describe('lock order', () => {
  it('waits for the company approval lock before it holds the header, as calculate and approve do', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`payroll_approval:${coA}`]);
      const pending = set(nov, comp.overtime!, 0);
      await vi.waitFor(async () => {
        const waiting = await pool.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
        expect(waiting.rowCount).toBeGreaterThan(0);
      }, { timeout: 4000, interval: 25 });
      // Taken with NOWAIT: a header held out of order would answer 55P03 here.
      await pool.query('SELECT 1 FROM payroll_run_headers WHERE id = $1 FOR UPDATE NOWAIT', [nov]);
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
      const res = await set(nov, comp[name]!, 100);
      expect(res.statusCode, JSON.stringify(res.body)).toBe(400);
      expect(await rows(comp[name]!)).toEqual([]);
    });

  it('offers only the editable components', async () => {
    const offered = (await get(nov)).body.data!.inputs.components.map((c: { id: string }) => c.id).sort();
    expect(offered).toEqual([comp.overtime, comp.commission, comp.union, await salaryComponent()].sort());
  });

  it.each([['a string', '1000'], ['negative', -1], ['three decimals', 1.005], ['too large', 1e13], ['missing', undefined], ['NaN', Number.NaN]])(
    'refuses an amount that is %s', async (_what, amount) => {
      expect((await set(nov, comp.overtime!, amount)).statusCode).toBe(400);
      expect(await rows(comp.overtime!)).toEqual([]);
    });

  it('company B\'s run is 404 and an employee of B on A\'s run is 400; neither writes', async () => {
    expect((await set(runB, comp.foreign!, 100, employeeB)).statusCode).toBe(404);
    expect((await set(runB, comp.overtime!, 100)).statusCode).toBe(404);
    expect((await set(nov, comp.overtime!, 100, employeeB)).statusCode).toBe(400);
    expect((await get(runB)).statusCode).toBe(404);
    expect(await rows(comp.foreign!, employeeB)).toEqual([]);
    expect(await rows(comp.overtime!, employeeB)).toEqual([]);
  });

  it('a viewer is 403', async () => {
    expect((await put(nov, { employeeId: employee, componentId: comp.overtime, amount: 1 }, { user: viewer })).statusCode).toBe(403);
    expect(await rows(comp.overtime!)).toEqual([]);
  });

  it('a tax year with no tables is refused before the write', async () => {
    const run = (await pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_month, period_year) VALUES ($1, 6, 2031) RETURNING id`, [coA])).rows[0]!.id;
    const res = await set(run, comp.overtime!, 100);
    expect(res.statusCode).toBe(400);
    expect(await rows(comp.overtime!)).toEqual([]);
    await pool.query('DELETE FROM payroll_run_headers WHERE id = $1', [run]);
  });

  it('a calculation failure after the write answers 500 and rolls the row back', async () => {
    failCalculation.on = true;
    try {
      expect((await set(nov, comp.overtime!, 100)).statusCode).toBe(500);
    } finally {
      failCalculation.on = false;
    }
    expect(await rows(comp.overtime!)).toEqual([]);
  });
});

describe('approval after an edit', () => {
  it('a preview taken before the edit is refused 409', async () => {
    const stale = (await preview(nov)).body.data!.planHash;
    expect((await set(nov, comp.overtime!, 1000)).statusCode).toBe(200);
    expect((await doApprove(nov, stale)).statusCode).toBe(409);
  });

  it('approve immediately after the edit posts the new figures', async () => {
    const { net } = await line(nov);
    const plan = (await preview(nov)).body.data!;
    expect(plan.plan.totals.gross).toBeCloseTo(SALARY + 1000, 2);
    const res = await doApprove(nov, plan.planHash);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const bank = (await pool.query(
      `SELECT l.credit::float8 AS credit FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
        WHERE l.journal_entry_id = $1 AND a.account_code = '1110'`, [res.body.data!.journalEntryId])).rows[0]!;
    expect(bank.credit).toBeCloseTo(net, 2);
  });

  it('an approved run is refused 400 and gets no row', async () => {
    expect((await set(nov, comp.commission!, 100)).statusCode).toBe(400);
    expect(await rows(comp.commission!)).toEqual([]);
  });

  it('a reopened run whose journal is in force and has loan work is refused before the write', async () => {
    expect((await call(reopen as Route, 'POST', `/api/payroll/runs/${nov}/reopen`, nov, { body: { reason: 'R loan refusal' } })).statusCode).toBe(200);
    await pool.query(
      `INSERT INTO payroll_loans (id, company_id, employee_id, loan_number, description, principal, annual_interest_rate, term_months,
         method, start_date, first_deduction_period_year, first_deduction_period_month, status, outstanding_balance)
       VALUES ($1, $2, $3, 'R-LOAN', 'Staff loan', 1000, 0.085, 1, 'straight_line', '2026-11-01', 2026, 11, 'active', 1000)`, [loan, coA, employee]);
    await pool.query(
      `INSERT INTO payroll_loan_schedule (loan_id, sequence, due_period_year, due_period_month, opening_balance, interest, principal, installment, closing_balance, paid_flag)
       VALUES ($1, 1, 2026, 11, 1000, 0, 1000, 1000, 0, false)`, [loan]);
    const res = await set(nov, comp.commission!, 100);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error?.message).toContain('Reverse the payroll journal first');
    expect(await rows(comp.commission!)).toEqual([]);
  });
});

async function salaryComponent(): Promise<string> {
  return (await pool.query(`SELECT id FROM payroll_components WHERE company_id = $1 AND name = 'Basic Salary'`, [coA])).rows[0]!.id;
}
