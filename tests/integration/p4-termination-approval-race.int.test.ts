/**
 * Audit 2026-10-18 P4, review round 2 (security review): the approval gate's
 * termination_already_paid check reads OTHER runs, which the run's header lock
 * does not cover. Two runs carrying the same employee's termination pay-outs,
 * approved at once, would both pass it and both pay. approvePayrollRun now
 * takes a company-scoped approval lock first.
 *
 * Made deterministic as in w3-01-approve-approve-race: the February approval
 * is parked just after its gate has judged (holding the locks, nothing
 * written), the March approval is started, and February is released once
 * March has either finished or is waiting on the approval lock. Real chain:
 * withAuth, app_user, RLS, Postgres. Disposable fixture DB only.
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
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: admin, company });

const NOTICE = { componentId: 'synthetic:termination:notice-pay', componentName: 'Notice Pay (Termination)', amount: 0 };

/** 'waiting' once a backend of this database waits on a lock while running a statement matching `text`. */
async function waitsOnLock(text: string): Promise<'waiting'> {
  for (let i = 0; i < 500; i += 1) {
    const r = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`, [`%${text}%`]);
    if (r.rowCount) return 'waiting';
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`nothing finished and nothing waited on a lock over ${text}`);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'P4 approval race']);
  await seedPayrollCompany(pool, company);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  tokens[admin] = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
  } finally { await pool.end(); }
});

describe('P4: two approvals carrying the same termination pay-outs', () => {
  it('are serialised: the second waits for the first, then is refused', async () => {
    const feb = await calculatedRun(call, 2);
    const mar = await calculatedRun(call, 3);
    // Both calculated before either was approved, both carrying the pay-out.
    await pool.query(
      `UPDATE payroll_run_lines SET component_breakdown = component_breakdown || $2::jsonb
        WHERE run_id = ANY($1::uuid[])`,
      [[feb, mar], JSON.stringify([NOTICE])],
    );
    const hash = async (id: string) => (await call(journalPlan as Route, 'GET',
      `/api/payroll/runs/${id}/journal-plan`, id)).body.data!.planHash;
    const approveRun = async (id: string, h: string) =>
      call(approve as Route, 'POST', `/api/payroll/runs/${id}/approve`, id, { body: { expectedPlanHash: h } });
    const [febHash, marHash] = [await hash(feb), await hash(mar)];

    let release!: () => void;
    gate.hold = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { gate.entered = r; });
    const firstP = approveRun(feb, febHash); // judges, then parks holding the approval lock
    await entered;
    const secondP = approveRun(mar, marHash);
    const state = await Promise.race([secondP.then(() => 'finished' as const), waitsOnLock('pg_advisory_xact_lock')]);
    release();
    const [first, second] = await Promise.all([firstP, secondP]);

    expect(state).toBe('waiting');
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
    expect(second.body.error?.message).toMatch(/already paid in an approved run/);
    const statuses = (await pool.query(
      'SELECT period_month, status FROM payroll_run_headers WHERE company_id = $1 ORDER BY period_month', [company])).rows;
    expect(statuses).toEqual([{ period_month: 2, status: 'approved' }, { period_month: 3, status: 'calculated' }]);
  });
});
