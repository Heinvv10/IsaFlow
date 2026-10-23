/**
 * W3-01 review round 2 (BRK-596 R2-2) — calculate vs approve on the same run.
 *
 * calculatePayrollRun read the header without a lock, checked its status,
 * then (much later) rewrote the lines and UPDATEd the header back to
 * 'calculated' with no status predicate. An approve that committed in between
 * was silently undone: the run went back to 'calculated' with new totals while
 * it still carried the journal approve had posted for the old ones.
 *
 * The breaker's interleaving, made deterministic: calculate is parked right
 * after its status check (inside listPayrollRunEmployees), a real approve is
 * started, and calculate is released only once that approve has either
 * finished or is waiting on the run's row lock. Everything else is the real
 * chain (withAuth, app_user, RLS, Postgres). Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';

const gate = vi.hoisted(() => ({ hold: null as null | Promise<void>, entered: null as null | (() => void) }));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/payroll/payrollEmployeeService')>();
  return {
    ...actual,
    listPayrollRunEmployees: async (...a: Parameters<typeof actual.listPayrollRunEmployees>) => {
      if (gate.hold) { const hold = gate.hold; gate.hold = null; gate.entered?.(); await hold; }
      return actual.listPayrollRunEmployees(...a);
    },
  };
});

import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { runRecalculatedSince } from '@/modules/accounting/services/payroll/payrollJournalChain';
import { als } from '@/lib/als';
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
let salary = '';

/**
 * 'waiting' once a backend of this database waits on a lock over payroll_run_headers, or on the
 * company's payroll approval lock, which calculate also takes since cumulative PAYE (PAYE 4a
 * follow-ups G4) and so is where an approve now waits for a calculation in flight.
 */
async function waitsOnRunLock(): Promise<'waiting'> {
  for (let i = 0; i < 500; i += 1) {
    const r = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND (query ILIKE '%payroll_run_headers%' OR query ILIKE '%pg_advisory_xact_lock%')`);
    if (r.rowCount) return 'waiting';
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('approve neither finished nor waited on the run lock');
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'W301 race']);
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

describe('calculate vs approve (W3-01 round 2, R2-2)', () => {
  it('an approve arriving while a calculate is in flight is never silently undone by it', async () => {
    const id = await calculatedRun(call, 4);
    const url = (a: string) => `/api/payroll/runs/${id}/${a}`;
    const p = await call(journalPlan as Route, 'GET', url('journal-plan'), id);
    await pool.query('UPDATE payroll_employee_components SET amount = 30000 WHERE id = $1', [salary]);

    let release!: () => void;
    gate.hold = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { gate.entered = r; });
    const calcP = call(calculate as Route, 'POST', url('calculate'), id); // passes its status check, then parks
    await entered;
    const apprP = call(approve as Route, 'POST', url('approve'), id, { body: { expectedPlanHash: p.body.data!.planHash } });
    const state = await Promise.race([apprP.then(() => 'finished' as const), waitsOnRunLock()]);
    release();
    const [calc, appr] = await Promise.all([calcP, apprP]);

    const hdr = (await pool.query(
      'SELECT status, journal_entry_id, total_gross::float8 AS gross FROM payroll_run_headers WHERE id = $1', [id])).rows[0]!;
    // The calculate holds the run while it costs it; the approve waits, then
    // finds the figures it previewed gone and refuses. No journal, no lost update.
    expect(state).toBe('waiting');
    expect(calc.statusCode).toBe(200);
    expect(appr.statusCode).toBe(409);
    expect(hdr).toMatchObject({ status: 'calculated', journal_entry_id: null, gross: 30000 });
    expect((await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1 AND description = 'Payroll run 2026-04'", [company])).rows[0]!.n).toBe(0);
  });

  // Round 4. The seed and simulation scripts call calculatePayrollRun with NO
  // transaction open, so its header lock lasts one statement and an approve
  // can commit while it costs the run. The status predicate on its final
  // header UPDATE is then the only thing that stops that approval being
  // reverted to 'calculated' under its own posted journal.
  it('with no request transaction, a calculate cannot revert an approve that committed meanwhile', async () => {
    await pool.query('UPDATE payroll_employee_components SET amount = 20000 WHERE id = $1', [salary]);
    const id = await calculatedRun(call, 5);
    const url = (a: string) => `/api/payroll/runs/${id}/${a}`;
    const p = await call(journalPlan as Route, 'GET', url('journal-plan'), id);
    await pool.query('UPDATE payroll_employee_components SET amount = 30000 WHERE id = $1', [salary]);

    let release!: () => void;
    gate.hold = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { gate.entered = r; });
    const calcP = calculatePayrollRun(id, company).then(() => 'saved', (e: Error) => e.message); // as a script calls it
    await entered; // past its status check; its row lock already released
    const appr = await call(approve as Route, 'POST', url('approve'), id, { body: { expectedPlanHash: p.body.data!.planHash } });
    expect(appr.statusCode).toBe(200);
    release();

    expect(await calcP).toMatch(/locked while it was being calculated/);
    expect((await pool.query(
      'SELECT status, journal_entry_id, total_gross::float8 AS gross FROM payroll_run_headers WHERE id = $1', [id])).rows[0])
      .toEqual({ status: 'approved', journal_entry_id: appr.body.data!.journalEntryId, gross: 20000 });
  });

  // Round 5. "Recalculated since the journal posted" is read from timestamps: the run lines' against
  // the journal's. NOW() is a transaction's START, so a calculation whose transaction was already
  // open when the approval's began would stamp its lines EARLIER than the journal and pass for
  // "not recalculated" — the lines are stamped with the clock at the insert instead.
  it('a recalculation is seen as later than the journal even when its transaction began first', async () => {
    await pool.query('UPDATE payroll_employee_components SET amount = 20000 WHERE id = $1', [salary]);
    const id = await calculatedRun(call, 6);
    const url = (a: string) => `/api/payroll/runs/${id}/${a}`;
    const early = await pool.connect();
    try {
      await early.query('BEGIN');
      await early.query('SELECT NOW()'); // this transaction's clock is fixed here
      const p = await call(journalPlan as Route, 'GET', url('journal-plan'), id);
      const appr = await call(approve as Route, 'POST', url('approve'), id, { body: { expectedPlanHash: p.body.data!.planHash } });
      expect(appr.statusCode).toBe(200);
      const journal = String(appr.body.data!.journalEntryId);
      expect((await call(reopen as Route, 'POST', url('reopen'), id, { body: { reason: 'w301 clock stamp' } })).statusCode).toBe(200);
      expect(await runRecalculatedSince(company, id, journal)).toBe(false);

      await als.run({ client: early, userId: admin, companyId: company, claims: {} }, () => calculatePayrollRun(id, company));
      await early.query('COMMIT');
      expect(await runRecalculatedSince(company, id, journal)).toBe(true);
    } finally {
      await early.query('ROLLBACK');
      early.release();
    }
  });
});
