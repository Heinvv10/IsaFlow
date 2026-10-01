/**
 * W3-01 review round 3 — approval against what changes while it runs: a
 * second approval, a reversal undone, a cost-centre mapping.
 *
 * Two approvals of the same run at once:
 *
 * approvePayrollRun locks the run's header FOR UPDATE before it judges the
 * run. Without that lock both requests pass the gate on the same
 * 'calculated' run and both answer 200: the second is told it approved a run
 * someone else had already approved.
 *
 * Made deterministic: the first approve is parked just after its gate has
 * judged the run (so it holds the row lock and has not written), the second
 * is started, and the first is released only once the second has either
 * finished or is waiting on the run's row lock. Everything else is the real
 * chain (withAuth, app_user, RLS, Postgres). Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';

const gate = vi.hoisted(() => ({ hold: null as null | Promise<void>, entered: null as null | (() => void) }));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalGate', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/payroll/payrollApprovalGate')>();
  return {
    ...actual,
    judgePayrollApproval: async (...a: Parameters<typeof actual.judgePayrollApproval>) => {
      const judged = await actual.judgePayrollApproval(...a);
      if (gate.hold) { const hold = gate.hold; gate.hold = null; gate.entered?.(); await hold; }
      return judged;
    },
  };
});

import approve from '../../pages/api/payroll/runs/[id]/approve';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: admin, company });

/** 'waiting' once a backend of this database waits on a lock over payroll_run_headers. */
async function waitsOnRunLock(): Promise<'waiting'> {
  for (let i = 0; i < 500; i += 1) {
    const r = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%payroll_run_headers%'`);
    if (r.rowCount) return 'waiting';
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('the second approve neither finished nor waited on the run lock');
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'W301 approve race']);
  await seedPayrollCompany(pool, company);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  tokens[admin] = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM cost_centre_gl_mappings WHERE company_id = $1', [company]);
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
  } finally { await pool.end(); }
});

describe('approve vs approve (W3-01 round 3)', () => {
  it('of two approvals of one run at once, exactly one posts and the other is refused', async () => {
    const id = await calculatedRun(call, 7);
    const url = (a: string) => `/api/payroll/runs/${id}/${a}`;
    const p = await call(journalPlan as Route, 'GET', url('journal-plan'), id);
    const body = { expectedPlanHash: p.body.data!.planHash };

    let release!: () => void;
    gate.hold = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { gate.entered = r; });
    const firstP = call(approve as Route, 'POST', url('approve'), id, { body }); // judges the run, then parks
    await entered;
    const secondP = call(approve as Route, 'POST', url('approve'), id, { body });
    const state = await Promise.race([secondP.then(() => 'finished' as const), waitsOnRunLock()]);
    release();
    const [first, second] = await Promise.all([firstP, secondP]);

    // The second waits for the first, then finds the run approved and refuses.
    expect(state).toBe('waiting');
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
    expect(second.body.error?.message).toMatch(/Cannot approve payroll run with status 'approved'/);

    const journals = (await pool.query(
      "SELECT id FROM gl_journal_entries WHERE company_id = $1 AND description = 'Payroll run 2026-07'", [company])).rows;
    expect(journals).toHaveLength(1);
    expect(first.body.data).toMatchObject({ status: 'approved', journalEntryId: journals[0]!.id });
    const hdr = (await pool.query('SELECT status, journal_entry_id FROM payroll_run_headers WHERE id = $1', [id])).rows[0]!;
    expect(hdr).toEqual({ status: 'approved', journal_entry_id: journals[0]!.id });
  });

  // Breaker A's ledger guard. The gate judged the linked journal reversed with
  // its reversal standing — and then the reversal is itself reversed, putting
  // the amounts back in the ledger, before approval writes. The unlink carries
  // the judgement in its own WHERE, so no second journal is posted beside them.
  it('never posts a fresh journal once the old one\'s amounts are back in the ledger', async () => {
    const id = await calculatedRun(call, 9);
    const url = (a: string) => `/api/payroll/runs/${id}/${a}`;
    const plan = () => call(journalPlan as Route, 'GET', url('journal-plan'), id);
    const j1 = String((await call(approve as Route, 'POST', url('approve'), id, { body: { expectedPlanHash: (await plan()).body.data!.planHash } })).body.data!.journalEntryId);
    expect((await call(reopen as Route, 'POST', url('reopen'), id, { body: { reason: 'w301 ledger guard' } })).statusCode).toBe(200);
    const reverse = (journal: string) => call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id: journal, action: 'reverse' } });
    expect((await reverse(j1)).statusCode).toBe(200);
    const contra = String((await pool.query('SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1', [j1])).rows[0]!.id);
    const p = await plan();
    expect(p.body.data!.replaces).toMatchObject({ journalEntryId: j1 });

    let release!: () => void;
    gate.hold = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { gate.entered = r; });
    const apprP = call(approve as Route, 'POST', url('approve'), id, { body: { expectedPlanHash: p.body.data!.planHash } });
    await entered; // judged replaceable; nothing written yet
    expect((await reverse(contra)).statusCode).toBe(200);
    release();
    const appr = await apprP;

    expect(appr.statusCode).toBe(409);
    expect((await pool.query('SELECT status, journal_entry_id FROM payroll_run_headers WHERE id = $1', [id])).rows[0])
      .toEqual({ status: 'calculated', journal_entry_id: j1 });
    expect((await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1 AND source = 'auto_payroll' AND description = 'Payroll run 2026-09'", [company])).rows[0]!.n).toBe(1);
  });

  // Breaker D: the hash was checked against the gate's plan and the poster then
  // built its own. A cost-centre mapping committed in between was posted under
  // a hash that never described it (previewed 5240, posted 5250, 200).
  it('posts the plan that was hashed, not one rebuilt after the check', async () => {
    const account = async (code: string) => (await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
       VALUES ($1,$2,$3,'expense','debit',1) RETURNING id`, [company, code, `W301 labour ${code}`])).rows[0]!.id as string;
    const shown = await account('5240');
    const later = await account('5250');
    const centre = crypto.randomUUID();
    await pool.query("INSERT INTO cost_centres (id, company_id, code, name) VALUES ($1,$2,'D-CC','D-CC')", [centre, company]);
    await pool.query('INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id) VALUES ($1,$2,$3)', [company, centre, shown]);
    await pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE company_id = $2', [centre, company]);

    const id = await calculatedRun(call, 8);
    const url = (a: string) => `/api/payroll/runs/${id}/${a}`;
    const p = await call(journalPlan as Route, 'GET', url('journal-plan'), id);
    const previewed = (p.body.data!.plan.lines as Array<{ accountCode: string; debit: number }>).filter((l) => l.debit > 0);
    expect(previewed.map((l) => l.accountCode)).toEqual(['5240']);

    let release!: () => void;
    gate.hold = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { gate.entered = r; });
    const apprP = call(approve as Route, 'POST', url('approve'), id, { body: { expectedPlanHash: p.body.data!.planHash } });
    await entered; // judged and hash-checked against 5240; nothing written yet
    await pool.query('UPDATE cost_centre_gl_mappings SET expense_account_id = $1 WHERE cost_centre_id = $2', [later, centre]);
    release();
    const appr = await apprP;

    expect(appr.statusCode).toBe(200);
    const debits = (await pool.query(
      `SELECT a.account_code, l.debit::float8 AS debit FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
        WHERE l.journal_entry_id = $1 AND l.debit > 0`, [appr.body.data!.journalEntryId])).rows;
    expect(debits).toEqual([{ account_code: '5240', debit: previewed[0]!.debit }]);
  });
});
