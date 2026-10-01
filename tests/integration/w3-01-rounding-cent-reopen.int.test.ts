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

  it('still refuses a split that really moved, and a real one-cent change', async () => {
    const id = await calculatedRun(call, 9);
    expect((await doApprove(id)).statusCode).toBe(200);
    expect((await doReopen(id)).statusCode).toBe(200);

    // 60/40 instead of 50/50: thousands of rand between the two accounts.
    await pool.query('UPDATE payroll_employee_cost_allocations SET percentage = 60 WHERE employee_id = $1 AND cost_centre_id = $2', [employee, ccLow]);
    await pool.query('UPDATE payroll_employee_cost_allocations SET percentage = 40 WHERE employee_id = $1 AND cost_centre_id = $2', [employee, ccHigh]);
    expect((await preview(id)).body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
    expect((await doApprove(id)).statusCode).toBe(400);
    await pool.query('UPDATE payroll_employee_cost_allocations SET percentage = 50 WHERE employee_id = $1', [employee]);
    expect((await preview(id)).body.data!.blocker).toBeNull();

    // One cent more salary, recalculated: a cent on net pay, not a placement.
    await pool.query('UPDATE payroll_employee_components SET amount = 20000.02 WHERE id = $1', [salary]);
    expect((await call(calculate as Route, 'POST', url(id, 'calculate'), id)).statusCode).toBe(200);
    expect((await preview(id)).body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });

    // The same again where the split DOES leave a cent over (R20 177.15), so a
    // cent of drift is within what rounding could explain — but it sits on
    // net pay, and only a cent between labour accounts is a placement.
    const next = await calculatedRun(call, 10);
    expect((await doApprove(next)).statusCode).toBe(200);
    expect((await doReopen(next)).statusCode).toBe(200);
    await pool.query('UPDATE payroll_employee_components SET amount = 20000.03 WHERE id = $1', [salary]);
    expect((await call(calculate as Route, 'POST', url(next, 'calculate'), next)).statusCode).toBe(200);
    expect((await preview(next)).body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
  });
});
