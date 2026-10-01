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

/** 'waiting' once a backend of this database waits on a lock while running a statement over `table`. */
async function waitsOnLock(table: string): Promise<'waiting'> {
  for (let i = 0; i < 500; i += 1) {
    const r = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`, [`%${table}%`]);
    if (r.rowCount) return 'waiting';
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`nothing finished and nothing waited on a ${table} lock`);
}
const waitsOnRunLock = () => waitsOnLock('payroll_run_headers');

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

  // Round 4: approval judged the linked journal ("live, same figures" or
  // "reversed, reversal stands") without locking it, so a reversal could
  // commit between that judgement and approval's writes. It now locks the
  // journal and then its reversal, under the header lock, and judges inside
  // those locks — a reversal either finished before approval looked or waits
  // until approval has committed.
  describe('the linked journal is locked while approval decides', () => {
    const reverse = (journal: string) => call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id: journal, action: 'reverse' } });
    const approved = async (month: number) => {
      const id = await calculatedRun(call, month);
      const url = (a: string) => `/api/payroll/runs/${id}/${a}`;
      const plan = () => call(journalPlan as Route, 'GET', url('journal-plan'), id);
      const appr = async () => call(approve as Route, 'POST', url('approve'), id, { body: { expectedPlanHash: (await plan()).body.data!.planHash } });
      const j1 = String((await appr()).body.data!.journalEntryId);
      expect((await call(reopen as Route, 'POST', url('reopen'), id, { body: { reason: 'w301 journal lock' } })).statusCode).toBe(200);
      return { id, j1, plan, appr };
    };
    const park = () => {
      let release!: () => void;
      gate.hold = new Promise<void>((r) => { release = r; });
      const entered = new Promise<void>((r) => { gate.entered = r; });
      return { release, entered };
    };
    const header = async (id: string) => (await pool.query('SELECT status, journal_entry_id FROM payroll_run_headers WHERE id = $1', [id])).rows[0];

    it('re-approving onto a live journal: a reversal of it waits for the approval', async () => {
      const { id, j1, plan } = await approved(9);
      const hash = (await plan()).body.data!.planHash; // before parking: the preview runs the gate too
      const { release, entered } = park();
      const apprP = call(approve as Route, 'POST', `/api/payroll/runs/${id}/approve`, id, { body: { expectedPlanHash: hash } });
      await entered; // judged "live, same figures"; nothing written yet
      const revP = reverse(j1);
      const state = await Promise.race([revP.then(() => 'finished' as const), waitsOnLock('gl_journal_entries')]);
      release();
      const [appr1, rev] = await Promise.all([apprP, revP]);

      expect(state).toBe('waiting');
      expect(appr1.statusCode).toBe(200);
      expect(appr1.body.data).toMatchObject({ journalEntryId: j1 });
      // The reversal ran AFTER the approval committed: a later act on an approved run, not a torn one.
      expect(rev.statusCode).toBe(200);
      expect(await header(id)).toEqual({ status: 'approved', journal_entry_id: j1 });
    });

    it('a journal being reversed when approval arrives: approval waits, then judges what was committed', async () => {
      const { id, j1, plan } = await approved(10);
      const hash = (await plan()).body.data!.planHash;
      // Stands in for a reversal mid-transaction: it has claimed the journal (reversed_at) and not committed.
      const peer = await pool.connect();
      let res: Awaited<ReturnType<typeof call>>;
      let state: 'finished' | 'waiting';
      try {
        await peer.query('BEGIN');
        await peer.query('UPDATE gl_journal_entries SET reversed_at = NOW() WHERE id = $1', [j1]);
        const apprP = call(approve as Route, 'POST', `/api/payroll/runs/${id}/approve`, id, { body: { expectedPlanHash: hash } });
        state = await Promise.race([apprP.then(() => 'finished' as const), waitsOnLock('gl_journal_entries')]);
        await peer.query('COMMIT');
        res = await apprP;
      } finally {
        await peer.query('ROLLBACK');
        peer.release();
      }
      expect(state).toBe('waiting');
      // Reversed, with no standing reversal to show for it: neither re-locked onto it nor replaced.
      expect(res.statusCode).toBe(400);
      expect(res.body.error?.message).toMatch(/can neither be re-approved onto it nor post a new one/);
      expect(await header(id)).toEqual({ status: 'calculated', journal_entry_id: j1 });
    });

    it('replacing a reversed journal: a reversal of its reversal waits for the approval', async () => {
      const { id, j1, plan } = await approved(11);
      expect((await reverse(j1)).statusCode).toBe(200);
      const contra = String((await pool.query('SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1', [j1])).rows[0]!.id);
      const p = await plan();
      expect(p.body.data!.replaces).toMatchObject({ journalEntryId: j1 });

      const { release, entered } = park();
      const apprP = call(approve as Route, 'POST', `/api/payroll/runs/${id}/approve`, id, { body: { expectedPlanHash: p.body.data!.planHash } });
      await entered; // judged "reversed, reversal stands"; nothing written yet
      const revP = reverse(contra);
      const state = await Promise.race([revP.then(() => 'finished' as const), waitsOnLock('gl_journal_entries')]);
      // While approval is deciding, the old journal's amounts cannot come back into the ledger.
      expect(state).toBe('waiting');
      expect((await pool.query('SELECT reversed_at FROM gl_journal_entries WHERE id = $1', [contra])).rows[0]!.reversed_at).toBeNull();
      release();
      const [appr1] = await Promise.all([apprP, revP]);

      expect(appr1.statusCode).toBe(200);
      const j2 = String(appr1.body.data!.journalEntryId);
      expect(j2).not.toBe(j1);
      expect(await header(id)).toEqual({ status: 'approved', journal_entry_id: j2 });
    });
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
