/**
 * BRK-596 adversarial repros (W3-01 review round 1), adopted as tests: the
 * journal-plan preview against approve, through the real routes (withAuth,
 * app_user, RLS). Each repro asserted the defect; each now asserts the fix.
 * Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import runDetail from '../../pages/api/payroll/runs/[id]';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const admin = crypto.randomUUID();
const viewer = crypto.randomUUID();
const outsider = crypto.randomUUID();
const tokens: Record<string, string> = {};
const REQUIRED = ['5200', '2140', '2150', '2160', '1110'];
type Route = typeof approve;
type Body = { data?: Record<string, any>; error?: { message?: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const T = { gross: 100000, paye: 20000, uif: 1500, sdl: 1000, eti: 0, net: 79250 };

async function run(company: string, month: number, status = 'calculated'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO payroll_run_headers(company_id,period_month,period_year,status,total_gross,total_taxable,
       total_paye,total_uif,total_sdl,total_eti,total_net,employee_count)
     VALUES($1,$2,2026,$9,$3,$3,$4,$5,$6,$7,$8,1) RETURNING id`,
    [company, month, T.gross, T.paye, T.uif, T.sdl, T.eti, T.net, status])).rows[0]!.id;
}

async function call(route: Route, method: string, action: string, runId: unknown, opts: { company?: string; user?: string; body?: unknown } = {}) {
  const req = request({ 'sb-access-token': tokens[opts.user ?? admin]!, active_company_id: opts.company ?? companyA }, method) as never as {
    url: string; body: unknown; query: Record<string, unknown>;
  };
  req.query = { id: runId };
  req.url = `/api/payroll/runs/${String(runId)}${action ? `/${action}` : ''}`;
  req.body = opts.body;
  const result = response();
  await route(req as never, result.res);
  return result.state as { statusCode: number; body: Body };
}
const preview = (id: unknown, o = {}) => call(journalPlan as Route, 'GET', 'journal-plan', id, o);
const doApprove = (id: unknown, o = {}) => call(approve, 'POST', 'approve', id, o);
const doCalculate = (id: unknown, o = {}) => call(calculate as Route, 'POST', 'calculate', id, o);

async function header(runId: string) {
  return (await pool.query('SELECT status, journal_entry_id, total_gross::float8 AS gross FROM payroll_run_headers WHERE id=$1', [runId])).rows[0]!;
}
async function journalDebit(journalId: string): Promise<number> {
  return Number((await pool.query('SELECT sum(debit)::float8 AS d FROM gl_journal_lines WHERE journal_entry_id=$1', [journalId])).rows[0]!.d);
}
async function payrollJournals(company: string, desc: string): Promise<number> {
  return (await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND description=$2', [company, desc])).rows[0]!.n;
}

beforeAll(async () => {
  for (const [id, name] of [[companyA, 'BRK596 A'], [companyB, 'BRK596 B']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
    for (const code of REQUIRED) {
      const type = code === '5200' ? 'expense' : code === '1110' ? 'asset' : 'liability';
      await pool.query(
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
         VALUES ($1,$2,$3,$4,$5,1)`, [id, code, `BRK ${code}`, type, type === 'liability' ? 'credit' : 'debit']);
    }
  }
  for (const u of [admin, viewer, outsider]) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [u, `${u}@test.local`]);
    tokens[u] = await new SignJWT({ sub: u, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }
  for (const c of [companyA, companyB]) await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [c, admin]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'viewer')", [companyA, viewer]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [companyB, outsider]);
});

afterAll(async () => {
  const ids = [companyA, companyB];
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, viewer, outsider]]);
  } finally { await pool.end(); }
});

describe('BRK-596', () => {
  it('REPRO 1: concurrent double approve posts ONE journal', async () => {
    const id = await run(companyA, 1);
    await Promise.all([doApprove(id), doApprove(id), doApprove(id), doApprove(id)]);
    expect(await payrollJournals(companyA, 'Payroll run 2026-01')).toBe(1);
  });

  it('REPRO 2: stale page (a peer already approved) — the preview refuses exactly what approve refuses', async () => {
    const id = await run(companyA, 2);
    expect((await doApprove(id)).statusCode).toBe(200); // peer approves
    const p = await preview(id);
    const a = await doApprove(id);
    expect(p.statusCode).toBe(200);
    expect(a.statusCode).toBe(400);
    expect(p.body.data!.blocker).toEqual({ code: 'status_not_approvable', detail: a.body.error!.message });
  });

  it('REPRO 2b: cancelled / paid run — the preview refuses exactly what approve refuses', async () => {
    for (const [m, s] of [[3, 'cancelled'], [4, 'paid']] as const) {
      const id = await run(companyA, m, s);
      const p = await preview(id);
      const a = await doApprove(id);
      expect(a.statusCode).toBe(400);
      expect(p.body.data!.blocker).toEqual({ code: 'status_not_approvable', detail: a.body.error!.message });
    }
  });

  it('REPRO 3: a run changed between preview and approve is refused 409, and nothing is written', async () => {
    const id = await run(companyA, 5);
    const p = await preview(id);
    // Another session recalculates (simulated as the header write calculatePayrollRun makes).
    await pool.query('UPDATE payroll_run_headers SET total_gross=200000, total_net=179250 WHERE id=$1', [id]);
    const a = await doApprove(id, { body: { expectedPlanHash: p.body.data!.planHash } });
    expect(a.statusCode).toBe(409);
    expect(a.body.error!.message).toBe('Payroll run changed while you were reviewing it');
    expect(await header(id)).toMatchObject({ status: 'calculated', journal_entry_id: null });
    expect(await payrollJournals(companyA, 'Payroll run 2026-05')).toBe(0);
    // Re-reviewed: the fresh hash approves, and posts what was previewed.
    const p2 = await preview(id);
    const ok = await doApprove(id, { body: { expectedPlanHash: p2.body.data!.planHash } });
    expect(ok.statusCode).toBe(200);
    expect(await journalDebit(ok.body.data!.journalEntryId)).toBe(p2.body.data!.plan.totalDebit);
  });

  it('REPRO 3b: a non-string expectedPlanHash is a 400', async () => {
    const id = await run(companyA, 9);
    expect((await doApprove(id, { body: { expectedPlanHash: ['x'] } })).statusCode).toBe(400);
    expect((await header(id)).status).toBe('calculated');
  });

  it('REPRO 4: a reopened run recalculated after posting cannot be re-approved onto the old journal', async () => {
    const id = await run(companyA, 6);
    const first = await doApprove(id);
    expect(first.statusCode).toBe(200);
    const je = first.body.data!.journalEntryId;
    expect((await call(reopen as Route, 'POST', 'reopen', id, { body: { reason: 'brk596 reopen' } })).statusCode).toBe(200);
    expect((await doCalculate(id)).statusCode).toBe(200); // the drift is refused at approval
    const p = await preview(id);
    const again = await doApprove(id);
    expect(p.body.data!.blocker!.code).toBe('recalculated_after_posting');
    expect(again.statusCode).toBe(400);
    expect(again.body.error!.message).toBe(p.body.data!.blocker!.detail);
    expect((await header(id)).status).toBe('calculated');
    expect(await journalDebit(je)).toBe(101750);
  });

  it('REPRO 4b: a reopened run NOT recalculated shows the posted journal and re-locks onto it', async () => {
    const id = await run(companyA, 10);
    const je = (await doApprove(id)).body.data!.journalEntryId;
    expect((await call(reopen as Route, 'POST', 'reopen', id, { body: { reason: 'brk596 reopen' } })).statusCode).toBe(200);
    const p = await preview(id);
    expect(p.body.data!.blocker).toBeNull();
    expect(p.body.data!.posted).toMatchObject({ journalEntryId: je, totalDebit: 101750 });
    const again = await doApprove(id, { body: { expectedPlanHash: p.body.data!.planHash } });
    expect(again.statusCode).toBe(200);
    expect(again.body.data!.journalEntryId).toBe(je);
    expect(await payrollJournals(companyA, 'Payroll run 2026-10')).toBe(1);
  });

  it('REPRO 4c: a reopened run whose journal was reversed cannot be re-locked onto it', async () => {
    const id = await run(companyA, 11);
    const je = (await doApprove(id)).body.data!.journalEntryId;
    expect((await call(reopen as Route, 'POST', 'reopen', id, { body: { reason: 'brk596 reopen' } })).statusCode).toBe(200);
    await pool.query("UPDATE gl_journal_entries SET status = 'reversed' WHERE id = $1", [je]);
    const p = await preview(id);
    const a = await doApprove(id);
    expect(p.body.data!.blocker!.code).toBe('posted_journal_not_live');
    expect(a.statusCode).toBe(400);
    expect(a.body.error!.message).toBe(p.body.data!.blocker!.detail);
  });

  it('REPRO 5: cross-tenant and malformed ids', async () => {
    const foreign = await run(companyB, 7);
    expect((await preview(foreign)).statusCode).toBe(404); // admin, active company A, B's run
    expect((await preview(foreign, { user: outsider, company: companyA })).statusCode).toBeGreaterThanOrEqual(401);
    expect((await preview([foreign, foreign])).statusCode).toBe(400);
    expect((await preview("x' OR 1=1--")).statusCode).toBe(400);
  });

  it('REPRO 6: a viewer can neither preview, approve nor recalculate', async () => {
    const id = await run(companyA, 8);
    expect((await preview(id, { user: viewer })).statusCode).toBe(403);
    expect((await doApprove(id, { user: viewer })).statusCode).toBe(403);
    expect((await doCalculate(id, { user: viewer })).statusCode).toBe(403);
    expect(await header(id)).toMatchObject({ status: 'calculated', gross: 100000 });
    // The run detail GET is unchanged here (reported, not fixed): a viewer still reads it.
    expect((await call(runDetail as Route, 'GET', '', id, { user: viewer })).statusCode).toBe(200);
  });
});
