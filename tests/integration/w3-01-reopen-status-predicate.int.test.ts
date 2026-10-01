/**
 * W3-01 breaker round 3, LOW — reopenPayrollRun wrote 'calculated' with no
 * status predicate. It read the status, judged it, and then UPDATEd by id
 * alone, so a run that left 'approved' between the read and the write (paid,
 * here) was reopened anyway: a paid run back in 'calculated'.
 *
 * Deterministic: a peer marks the run paid and holds the row. The reopen reads
 * 'approved' (the peer has not committed), blocks on its UPDATE, and the peer
 * commits only once it is seen waiting. Real route; disposable fixture DB.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Parks a caller right after its header lock's own transaction committed — what a caller
// with NO request transaction (a script) does between the lock and its UPDATE.
const gate = vi.hoisted(() => ({ hold: null as null | Promise<void>, entered: null as null | (() => void) }));
vi.mock('@/lib/neon', async (orig) => {
  const actual = await orig<typeof import('@/lib/neon')>();
  return {
    ...actual,
    withTransaction: async <T>(fn: Parameters<typeof actual.withTransaction<T>>[0]) => {
      const out = await actual.withTransaction(fn);
      if (gate.hold) { const hold = gate.hold; gate.hold = null; gate.entered?.(); await hold; }
      return out;
    },
  };
});

import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { als } from '@/lib/als';
import { reopenPayrollRun } from '@/modules/accounting/services/payroll/payrollRunLock';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: admin, company });

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'W301 reopen predicate']);
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

describe('reopen — the status write is predicated (W3-01 breaker LOW)', () => {
  it('a run paid between the reopen\'s read and its write stays paid', async () => {
    const id = await calculatedRun(call, 3);
    const url = (a: string) => `/api/payroll/runs/${id}/${a}`;
    const p = await call(journalPlan as Route, 'GET', url('journal-plan'), id);
    expect((await call(approve as Route, 'POST', url('approve'), id, { body: { expectedPlanHash: p.body.data!.planHash } })).statusCode).toBe(200);

    const peer = await pool.connect();
    let res: Awaited<ReturnType<typeof call>>;
    try {
      await peer.query('BEGIN');
      await peer.query("UPDATE payroll_run_headers SET status = 'paid' WHERE id = $1", [id]);
      const reopenP = call(reopen as Route, 'POST', url('reopen'), id, { body: { reason: 'w301 reopen predicate' } });
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i += 1) {
        waiting = ((await pool.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%payroll_run_headers%'`)).rowCount ?? 0) > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting).toBe(true); // blocked behind the peer (round 5: on the header lock, before it reads the status)
      await peer.query('COMMIT');
      res = await reopenP;
    } finally {
      await peer.query('ROLLBACK');
      peer.release();
    }

    expect(res.statusCode).toBe(400);
    expect((await pool.query('SELECT status FROM payroll_run_headers WHERE id = $1', [id])).rows[0]!.status).toBe('paid');
  });

  // Round 6. The route above ends 400 whether the header lock or the status predicate stopped
  // it, and answers "Reopen failed" either way. These two pin each guard on its own.
  const approvedRun = async (month: number) => {
    const id = await calculatedRun(call, month);
    const url = (a: string) => `/api/payroll/runs/${id}/${a}`;
    const p = await call(journalPlan as Route, 'GET', url('journal-plan'), id);
    expect((await call(approve as Route, 'POST', url('approve'), id, { body: { expectedPlanHash: p.body.data!.planHash } })).statusCode).toBe(200);
    return id;
  };
  const status = async (id: string) => (await pool.query('SELECT status FROM payroll_run_headers WHERE id = $1', [id])).rows[0]!.status;
  const reopenArgs = (id: string) => ({ runId: id, companyId: company, userId: admin, reason: 'w301 reopen guards' });

  it('in a request transaction, reopen waits on the header lock and judges the committed status', async () => {
    const id = await approvedRun(4);
    const peer = await pool.connect();
    const mine = await pool.connect();
    let outcome: string;
    try {
      await peer.query('BEGIN');
      await peer.query("UPDATE payroll_run_headers SET status = 'paid' WHERE id = $1", [id]);
      await mine.query('BEGIN');
      const p = als.run({ client: mine, userId: admin, companyId: company, claims: {} }, () => reopenPayrollRun(reopenArgs(id)))
        .then(() => 'reopened', (e: Error) => e.message);
      await new Promise((r) => setTimeout(r, 500));
      await peer.query('COMMIT');
      outcome = await p;
      await mine.query('ROLLBACK');
    } finally {
      await peer.query('ROLLBACK');
      peer.release(); mine.release();
    }
    // The status check read 'paid', after the lock — not the UPDATE's predicate.
    expect(outcome).toMatch(/Paid runs cannot be reopened/);
    expect(await status(id)).toBe('paid');
  });

  it('with no transaction open, the status predicate stops a reopen that read approved before the run was paid', async () => {
    const id = await approvedRun(5);
    let release!: () => void;
    gate.hold = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { gate.entered = r; });
    const p = reopenPayrollRun(reopenArgs(id)).then(() => 'reopened', (e: Error) => e.message);
    await entered; // its lock's transaction committed; it read 'approved'
    await pool.query("UPDATE payroll_run_headers SET status = 'paid' WHERE id = $1", [id]);
    release();
    expect(await p).toMatch(/changed while it was being reopened/);
    expect(await status(id)).toBe('paid');
  });
});
