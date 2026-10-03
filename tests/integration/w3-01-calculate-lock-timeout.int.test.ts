/**
 * W3-01 review round 3 — calculatePayrollRun's header lock is bounded.
 *
 * The FOR UPDATE added in round 2 had no lock_timeout: a calculate arriving
 * while a peer held the run's row waited for as long as the peer did, pinning
 * its connection. It now waits 5s and answers the retryable refusal the loan
 * lock in the same function already answers (payrollRunLoanApplication.ts).
 *
 * The peer here is a second connection holding the row for real, so the
 * refusal comes from Postgres' own 55P03. Everything else is the real chain
 * (withAuth, app_user, RLS). Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { als } from '@/lib/als';
import { lockPayrollRunHeader } from '@/modules/accounting/services/payroll/payrollRunLock';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
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
let salary = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'W301 lock timeout']);
  salary = await seedPayrollCompany(pool, company);
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

describe('calculate — the run header lock is bounded (W3-01 round 3)', () => {
  it('a calculate that cannot get the run row within 5s is refused, retryable, and writes nothing', async () => {
    const id = await calculatedRun(call, 5);
    await pool.query('UPDATE payroll_employee_components SET amount = 30000 WHERE id = $1', [salary]);

    const peer = await pool.connect();
    // The peer lets go after 9s whatever happens, so an unbounded wait ends
    // (as a 200) instead of hanging the suite.
    const letGo = setTimeout(() => { void peer.query('ROLLBACK'); }, 9000);
    let res: Awaited<ReturnType<typeof call>>;
    let waitedMs: number;
    try {
      await peer.query('BEGIN');
      await peer.query('SELECT id FROM payroll_run_headers WHERE id = $1 FOR UPDATE', [id]);
      const started = Date.now();
      res = await call(calculate as Route, 'POST', `/api/payroll/runs/${id}/calculate`, id);
      waitedMs = Date.now() - started;
    } finally {
      clearTimeout(letGo);
      await peer.query('ROLLBACK');
      peer.release();
    }

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatchObject({ details: { code: 'PAYROLL_LOAN_LOCK_TIMEOUT' } });
    expect(res.body.error?.message).toMatch(/retry in a moment/);
    expect(waitedMs).toBeGreaterThanOrEqual(4500);
    expect(waitedMs).toBeLessThan(8500);
    // withAuth COMMITs a 4xx: the run must be exactly as it was.
    const hdr = (await pool.query(
      'SELECT status, total_gross::float8 AS gross FROM payroll_run_headers WHERE id = $1', [id])).rows[0]!;
    expect(hdr).toEqual({ status: 'calculated', gross: 20000 });
    const lines = (await pool.query(
      'SELECT gross_pay::float8 AS gross FROM payroll_run_lines WHERE run_id = $1', [id])).rows;
    expect(lines).toEqual([{ gross: 20000 }]);

    // And the row is free again: the same calculate now goes through.
    const again = await call(calculate as Route, 'POST', `/api/payroll/runs/${id}/calculate`, id);
    expect(again.statusCode).toBe(200);
    expect(again.body.data).toMatchObject({ totalGross: 30000 });
  }, 30000);

  // Round 4: approve took the same row lock with no budget at all.
  it('an approve that cannot get the run row within 5s is refused the same way, and writes nothing', async () => {
    const id = await calculatedRun(call, 7);
    const url = (a: string) => `/api/payroll/runs/${id}/${a}`;
    const body = { expectedPlanHash: (await call(journalPlan as Route, 'GET', url('journal-plan'), id)).body.data!.planHash };

    const peer = await pool.connect();
    const letGo = setTimeout(() => { void peer.query('ROLLBACK'); }, 9000);
    let res: Awaited<ReturnType<typeof call>>;
    let waitedMs: number;
    try {
      await peer.query('BEGIN');
      await peer.query('SELECT id FROM payroll_run_headers WHERE id = $1 FOR UPDATE', [id]);
      const started = Date.now();
      res = await call(approve as Route, 'POST', url('approve'), id, { body });
      waitedMs = Date.now() - started;
    } finally {
      clearTimeout(letGo);
      await peer.query('ROLLBACK');
      peer.release();
    }

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatchObject({ details: { code: 'PAYROLL_LOAN_LOCK_TIMEOUT' } });
    expect(waitedMs).toBeGreaterThanOrEqual(4500);
    expect(waitedMs).toBeLessThan(8500);
    expect((await pool.query('SELECT status, journal_entry_id FROM payroll_run_headers WHERE id = $1', [id])).rows[0])
      .toEqual({ status: 'calculated', journal_entry_id: null });
    // The row is free again and the same approval goes through.
    expect((await call(approve as Route, 'POST', url('approve'), id, { body })).statusCode).toBe(200);
  }, 30000);

  it('the 5s budget does not stay on the transaction once the lock is granted', async () => {
    // SET LOCAL lasts for the TRANSACTION. Under withAuth the helper only nests
    // a savepoint, so a 5s left in force would bound every later statement of
    // the calculation — statements that had no timeout before.
    const id = await calculatedRun(call, 6);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '17s'");
      const row = await als.run(
        { client, userId: admin, companyId: company, claims: {} },
        () => lockPayrollRunHeader(id, company),
      );
      expect(String(row?.id)).toBe(id);
      expect((await client.query("SELECT current_setting('lock_timeout') AS v")).rows).toEqual([{ v: '17s' }]);
      // Granted inside the helper's savepoint, still held by the transaction.
      const peer = await pool.query('SELECT id FROM payroll_run_headers WHERE id = $1 FOR UPDATE NOWAIT', [id])
        .then(() => 'granted', (e: { code?: string }) => e.code);
      expect(peer).toBe('55P03');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
