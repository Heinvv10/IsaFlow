/**
 * W3-01 review round 3 — a reopened run whose journal carries the labour
 * split's rounding cent on another cost-centre account is NOT "recalculated
 * after posting".
 *
 * Round 2 gave buildLabourLines an ORDER BY. Before it, the cent a split
 * leaves over went to whichever allocation the heap returned last, so a
 * journal posted then can differ from today's plan by that cent between two
 * labour accounts — and the gate, which compares the two per account, told the
 * user to reverse a journal that was never wrong.
 *
 * The old read order cannot be reproduced, so the same one-cent difference is
 * reached the way the product can reach it: the run is approved, reopened, and
 * the two cost centres' expense accounts are swapped. Each account then holds
 * the other's half, and the halves differ only by the rounding cent. Real
 * routes throughout (withAuth, app_user, RLS). Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: admin, company });
const [ccLow, ccHigh] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string];
let salary = '';
let employee = '';
let acctA = '';
let acctB = '';
/** The third employee's pay in the tie-cent company: chosen so the split leaves one cent to place. */
const TIE_BREAKER = 10000.01;

const url = (id: string, action: string) => `/api/payroll/runs/${id}/${action}`;
const preview = (id: string) => call(journalPlan as Route, 'GET', url(id, 'journal-plan'), id);
const doReopen = (id: string) => call(reopen as Route, 'POST', url(id, 'reopen'), id, { body: { reason: 'w301 rounding cent' } });
async function doApprove(id: string) {
  return call(approve as Route, 'POST', url(id, 'approve'), id, { body: { expectedPlanHash: (await preview(id)).body.data?.planHash } });
}
const mapCentres = async (low: string, high: string) => {
  await pool.query('UPDATE cost_centre_gl_mappings SET expense_account_id = $1 WHERE cost_centre_id = $2', [low, ccLow]);
  await pool.query('UPDATE cost_centre_gl_mappings SET expense_account_id = $1 WHERE cost_centre_id = $2', [high, ccHigh]);
};
type Line = { glAccountId: string; debit: number };
const cents = (lines: Line[], account: string) => Math.round((lines.find((l) => l.glAccountId === account)?.debit ?? 0) * 100);

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'W301 rounding cent']);
  // R20 000.01 → labour cost R20 177.13 (gross + employer UIF), which does not halve to the cent.
  salary = await seedPayrollCompany(pool, company, 20000.01);
  employee = (await pool.query('SELECT id FROM payroll_employees WHERE company_id = $1', [company])).rows[0]!.id;
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  tokens[admin] = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
  const account = async (code: string) => (await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
     VALUES ($1,$2,$3,'expense','debit',1) RETURNING id`, [company, code, `W301 labour ${code}`])).rows[0]!.id as string;
  acctA = await account('5210');
  acctB = await account('5220');
  for (const [id, code, acct] of [[ccLow, 'CC-LOW', acctA], [ccHigh, 'CC-HIGH', acctB]] as const) {
    await pool.query('INSERT INTO cost_centres (id, company_id, code, name) VALUES ($1,$2,$3,$3)', [id, company, code]);
    await pool.query('INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id) VALUES ($1,$2,$3)', [company, id, acct]);
    await pool.query('INSERT INTO payroll_employee_cost_allocations (company_id, employee_id, cost_centre_id, percentage) VALUES ($1,$2,$3,50)', [company, employee, id]);
  }
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM cost_centre_gl_mappings WHERE company_id = $1', [company]);
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
  } finally { await pool.end(); }
});

describe('a reopened run and the labour split\'s rounding cent (W3-01 round 3)', () => {
  it('re-approves onto a journal that differs only by where the rounding cent sits', async () => {
    const id = await calculatedRun(call, 8);
    const first = await doApprove(id);
    expect(first.statusCode).toBe(200);
    const journalId = String(first.body.data!.journalEntryId);
    expect((await doReopen(id)).statusCode).toBe(200);

    await mapCentres(acctB, acctA);
    const p = await preview(id);
    const plan = p.body.data!.plan.lines as Line[];
    const posted = p.body.data!.posted.lines as Line[];
    // The state under test: the same labour total, one cent apart per account.
    expect(cents(plan, acctA) + cents(plan, acctB)).toBe(2017713);
    expect(cents(posted, acctA) + cents(posted, acctB)).toBe(2017713);
    expect(Math.abs(cents(plan, acctA) - cents(posted, acctA))).toBe(1);
    expect(Math.abs(cents(plan, acctB) - cents(posted, acctB))).toBe(1);

    expect(p.body.data!.blocker).toBeNull();
    const again = await doApprove(id);
    expect(again.statusCode).toBe(200);
    expect(again.body.data).toMatchObject({ status: 'approved', journalEntryId: journalId });
    expect((await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1 AND description = 'Payroll run 2026-08'", [company])).rows[0]!.n).toBe(1);
  });

  it('an allocation changed after posting is not a recalculation; a real one-cent change still is (breaker B)', async () => {
    const id = await calculatedRun(call, 9);
    const journalId = String((await doApprove(id)).body.data!.journalEntryId);
    expect((await doReopen(id)).statusCode).toBe(200);

    // 60/40 instead of 50/50 — thousands of rand between the two accounts in
    // TODAY's split, but the run was never recalculated and its journal is
    // what was approved: it re-locks onto it.
    await pool.query('UPDATE payroll_employee_cost_allocations SET percentage = 60 WHERE employee_id = $1 AND cost_centre_id = $2', [employee, ccLow]);
    await pool.query('UPDATE payroll_employee_cost_allocations SET percentage = 40 WHERE employee_id = $1 AND cost_centre_id = $2', [employee, ccHigh]);
    const p = await preview(id);
    expect(p.body.data!.blocker).toBeNull();
    expect(p.body.data!.posted).toMatchObject({ journalEntryId: journalId });
    const again = await doApprove(id);
    expect(again.statusCode).toBe(200);
    expect(again.body.data).toMatchObject({ journalEntryId: journalId });
    await pool.query('UPDATE payroll_employee_cost_allocations SET percentage = 50 WHERE employee_id = $1', [employee]);
    expect((await doReopen(id)).statusCode).toBe(200);

    // The LARGEST change the gate lets through: both mappings removed, so
    // today's plan puts the whole labour cost on 5200 while the journal has
    // none of it there. Still not a recalculation — the run's figures are the
    // journal's — so it re-locks onto the journal as posted, old split and all.
    await pool.query('DELETE FROM cost_centre_gl_mappings WHERE company_id = $1', [company]);
    const whole = await preview(id);
    const labour = (lines: Array<Line & { accountCode: string }>) => lines.filter((l) => l.debit > 0).map((l) => [l.accountCode, Math.round(l.debit * 100)]);
    expect(labour(whole.body.data!.plan.lines)).toEqual([['5200', 2017713]]);
    expect(labour(whole.body.data!.posted.lines).map(([code]) => code).sort()).toEqual(['5210', '5220']);
    expect(whole.body.data!.blocker).toBeNull();
    const relocked = await doApprove(id);
    expect(relocked.statusCode).toBe(200);
    expect(relocked.body.data).toMatchObject({ journalEntryId: journalId });
    expect((await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1 AND description = 'Payroll run 2026-09'", [company])).rows[0]!.n).toBe(1);
    expect((await doReopen(id)).statusCode).toBe(200);

    // One cent more salary, recalculated: the labour total and net pay move.
    await pool.query('UPDATE payroll_employee_components SET amount = 20000.02 WHERE id = $1', [salary]);
    expect((await call(calculate as Route, 'POST', url(id, 'calculate'), id)).statusCode).toBe(200);
    expect((await preview(id)).body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
    expect((await doApprove(id)).statusCode).toBe(400);
  });
});

/**
 * Breaker C: the rounding the split cannot place evenly goes on the largest
 * line, and before round 2 a TIE between largest lines went to whichever the
 * heap returned first. Two employees on the same pay in different cost
 * centres, and a third whose pay makes the total not divide: the tie cent sits
 * on one of the two centres' accounts. Swapping those accounts puts it on the
 * other — the journal an old read order would have posted.
 */
describe('the tie cent on the other cost-centre account (W3-01 breaker C)', () => {
  const other = crypto.randomUUID();
  const call2 = routeCaller(tokens, { user: admin, company: other });
  const [c1, c2] = [crypto.randomUUID(), crypto.randomUUID()];
  let a1 = '';
  let a2 = '';

  beforeAll(async () => {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'W301 tie cent']);
    await seedPayrollCompany(pool, other, 20000);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [other, admin]);
    const comp = (await pool.query('SELECT id FROM payroll_components WHERE company_id = $1', [other])).rows[0]!.id;
    const account = async (code: string) => (await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
       VALUES ($1,$2,$3,'expense','debit',1) RETURNING id`, [other, code, `W301 labour ${code}`])).rows[0]!.id as string;
    a1 = await account('5210');
    a2 = await account('5220');
    await pool.query('INSERT INTO cost_centres (id, company_id, code, name) VALUES ($1,$2,$3,$3), ($4,$2,$5,$5)', [c1, other, 'TIE-1', c2, 'TIE-2']);
    await pool.query('INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id) VALUES ($1,$2,$3), ($1,$4,$5)', [other, c1, a1, c2, a2]);
    // Wanda (seeded, R20 000) in centre 1; a twin on R20 000 in centre 2; a third on TIE_BREAKER with no centre.
    await pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE company_id = $2', [c1, other]);
    for (const [n, amount, centre, tax] of [['W301-2', 20000, c2, '0123456788'], ['W301-3', TIE_BREAKER, null, '0123456787']] as const) {
      const emp = (await pool.query(
        `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number, cost_centre_id)
         VALUES ($1, $2, 'Twin', $2, '2020-01-01', '1980-01-01', $3, $4) RETURNING id`, [other, n, tax, centre])).rows[0]!.id;
      await pool.query("INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1,$2,$3,'2020-01-01')", [emp, comp, amount]);
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cost_centre_gl_mappings WHERE company_id = $1', [other]);
    await cleanPayrollCompanies(pool, [other]);
  });

  it('re-approves onto a journal whose tie cent sits on the other cost centre', async () => {
    const id = await calculatedRun(call2, 8, { company: other });
    const o = { company: other };
    const pre = async () => call2(journalPlan as Route, 'GET', url(id, 'journal-plan'), id, o);
    const appr = async () => call2(approve as Route, 'POST', url(id, 'approve'), id, { ...o, body: { expectedPlanHash: (await pre()).body.data?.planHash } });
    const first = await appr();
    expect(first.statusCode).toBe(200);
    expect((await call2(reopen as Route, 'POST', url(id, 'reopen'), id, { ...o, body: { reason: 'w301 tie cent' } })).statusCode).toBe(200);

    await pool.query('UPDATE cost_centre_gl_mappings SET expense_account_id = CASE WHEN cost_centre_id = $1 THEN $2::uuid ELSE $3::uuid END WHERE company_id = $4', [c1, a2, a1, other]);
    const p = await pre();
    const plan = p.body.data!.plan.lines as Line[];
    const posted = p.body.data!.posted.lines as Line[];
    // The state under test: equal pay, so the two centres differ by the tie cent alone — now the other way round.
    expect(Math.abs(cents(posted, a1) - cents(posted, a2))).toBe(1);
    expect(cents(plan, a1)).toBe(cents(posted, a2));
    expect(cents(plan, a2)).toBe(cents(posted, a1));

    expect(p.body.data!.blocker).toBeNull();
    const again = await appr();
    expect(again.statusCode).toBe(200);
    expect(again.body.data).toMatchObject({ status: 'approved', journalEntryId: first.body.data!.journalEntryId });
  });
});
