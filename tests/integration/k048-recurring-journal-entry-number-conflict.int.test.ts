/**
 * K-048 adjacent: a contended `entry_number` is a 409, not a 500.
 *
 * `generate_journal_entry_number` computes MAX(seq)+1 in a BEFORE INSERT, so
 * two journals numbered inside overlapping transactions take the same number
 * and the loser gets 23505 on `uq_gl_je_company_entry_number`. That is
 * transient — the same Generate succeeds on retry — and the route's own
 * vocabulary already says transient contention answers 409. It answered a bare
 * INTERNAL_SERVER_ERROR, which tells an operator whose request was perfectly
 * valid that the system broke and offers no remedy.
 *
 * The collision is forced deterministically rather than raced: a second
 * connection holds an UNCOMMITTED row carrying the number the trigger is about
 * to mint, so the route's INSERT blocks on the unique index; the blocker is
 * committed only once `pg_blocking_pids` proves the route is actually waiting
 * on it, and the wait then resolves as 23505. No sleep, no timing assumption.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import action from '../../pages/api/accounting/recurring-journals-action';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const debitAccount = crypto.randomUUID(), creditAccount = crypto.randomUUID();
const template = crypto.randomUUID();
let adminToken = '';

const lines = JSON.stringify([
  { glAccountId: debitAccount, debit: 1000, credit: 0, description: 'K048 conflict DR' },
  { glAccountId: creditAccount, debit: 0, credit: 1000, description: 'K048 conflict CR' },
]);

/** The SAST calendar date — what the due-date guard compares against. */
function sastToday(): string {
  return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K048 entry-number fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
     VALUES($1,$2,'K048C-6000','K048C Rent expense','expense','debit',3,true),
            ($3,$2,'K048C-2000','K048C Accruals','liability','credit',3,true)`,
    [debitAccount, company, creditAccount],
  );
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     SELECT $1,'K048C ' || to_char(d,'Mon YYYY'), EXTRACT(MONTH FROM d)::int, EXTRACT(YEAR FROM d)::int,
            d, (d + INTERVAL '1 month - 1 day')::date, 'open'
     FROM generate_series(date_trunc('year', CURRENT_DATE), date_trunc('year', CURRENT_DATE) + INTERVAL '23 months', INTERVAL '1 month') d`,
    [company],
  );
  adminToken = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM recurring_journals WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

it('a journal numbered at the same moment answers 409 and posts nothing', async () => {
  const today = sastToday();
  await pool.query(
    `INSERT INTO recurring_journals(id,company_id,template_name,description,frequency,next_run_date,lines,total_amount,created_by,status)
     VALUES($1,$2,'K048C monthly accrual','K048C monthly accrual','monthly',$3::date,$4::jsonb,1000,$5,'active')`,
    [template, company, today, lines, admin],
  );

  // The number the trigger will mint: the company has no entries, so MAX+1 = 1
  // for the year the run is dated in.
  const contendedNumber = `JE-${today.slice(0, 4)}-00001`;

  const blocker = await pool.connect();
  let routeResult: ReturnType<typeof response>;
  try {
    await blocker.query('BEGIN');
    const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
    await blocker.query(
      `INSERT INTO gl_journal_entries(company_id,entry_date,created_by,entry_number,description,source,status)
       VALUES($1,$2::date,$3,$4,'K048C peer poster','manual','draft')`,
      [company, today, admin, contendedNumber],
    );

    const req = request({ 'sb-access-token': adminToken, active_company_id: company }, 'POST') as never as {
      url: string; body: unknown; query: Record<string, string>;
    };
    req.url = '/api/accounting/recurring-journals-action';
    req.query = {};
    req.body = { action: 'generate', id: template };
    routeResult = response();
    const inFlight = action(req as never, routeResult.res);

    // Commit only once the route's INSERT is demonstrably waiting on THIS
    // backend. Polling the lock graph is what makes the collision a fact
    // rather than a race the suite would flake on.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid]);
      if (rows[0].n > 0) break;
      if (Date.now() > deadline) throw new Error('the route never blocked on the contended entry number');
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    await blocker.query('COMMIT');
    await inFlight;
  } finally {
    blocker.release();
  }

  expect(routeResult!.state.statusCode).toBe(409);
  expect(JSON.stringify(routeResult!.state.body)).toMatch(/numbered at the same moment/i);

  // withAuth COMMITs a 4xx, so the ledger outcome — not the status code — is
  // what proves nothing was left behind: the action's own `withTransaction` is
  // a SAVEPOINT inside the request, rolled back on the 23505 before the route
  // ever answers.
  const posted = await pool.query(
    "SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='auto_recurring'", [company]);
  expect(posted.rows[0].n).toBe(0);
  const orphans = await pool.query('SELECT COUNT(*)::int AS n FROM gl_journal_lines WHERE company_id=$1', [company]);
  expect(orphans.rows[0].n).toBe(0);

  // The run was not consumed: the operator's retry is a real retry.
  const { rows } = await pool.query('SELECT run_count, next_run_date, last_run_date, status FROM recurring_journals WHERE id=$1', [template]);
  expect(Number(rows[0].run_count)).toBe(0);
  expect(String(rows[0].next_run_date)).toBe(today);
  expect(rows[0].last_run_date).toBeNull();
  expect(rows[0].status).toBe('active');
});
