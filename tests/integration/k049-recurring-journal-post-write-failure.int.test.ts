/**
 * K-049 — a failure raised AFTER the journal is written must reach the caller
 * as a 500, so `withAuth` ROLLBACKs and the write does not survive the refusal.
 *
 * Every fault the route can foresee is now pre-checked before the first write:
 * the due date, the fiscal period, and the template's own lines. What is left
 * is the residual class — a fault nobody predicted, or one that arrives in the
 * gap between the pre-check and the post (an account deactivated, a period
 * closed, by a concurrent request). `postJournalEntry` is stubbed to throw
 * because that residual class is the whole point: the route must not fold an
 * unknown failure into a 400, which `withAuth` COMMITs.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

vi.mock('@/modules/accounting/services/gl/journalEntryService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/accounting/services/gl/journalEntryService')>();
  return {
    ...actual,
    postJournalEntry: async () => {
      throw new Error('post failed after the entry was written');
    },
  };
});

const action = (await import('../../pages/api/accounting/recurring-journals-action')).default;

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), admin = crypto.randomUUID();
const debitAccount = crypto.randomUUID(), creditAccount = crypto.randomUUID();
const template = crypto.randomUUID();
let adminToken = '';
let today = '';

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K049 post-write fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
     VALUES($1,$2,'K049P-6000','K049P Rent expense','expense','debit',3,true),
            ($3,$2,'K049P-2000','K049P Accruals','liability','credit',3,true)`,
    [debitAccount, company, creditAccount],
  );
  const { rows } = await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     SELECT $1,'K049P ' || to_char(d,'Mon YYYY'), EXTRACT(MONTH FROM d)::int, EXTRACT(YEAR FROM d)::int,
            d, (d + INTERVAL '1 month - 1 day')::date, 'open'
     FROM generate_series(date_trunc('year', CURRENT_DATE), date_trunc('year', CURRENT_DATE) + INTERVAL '23 months', INTERVAL '1 month') d
     RETURNING 1`,
    [company],
  );
  expect(rows.length).toBeGreaterThan(0);
  // The SAST date, which is what businessToday() compares next_run_date to.
  // The UTC date is a day behind it for two hours each night.
  today = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO recurring_journals(id,company_id,template_name,description,frequency,next_run_date,lines,total_amount,created_by,status)
     VALUES($1,$2,'K049P monthly accrual','K049P monthly accrual','monthly',$3::date,$4::jsonb,1000,$5,'active')`,
    [template, company, today,
      JSON.stringify([
        { glAccountId: debitAccount, debit: 1000, credit: 0, description: 'K049P DR' },
        { glAccountId: creditAccount, debit: 0, credit: 1000, description: 'K049P CR' },
      ]), admin],
  );
  adminToken = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM recurring_journals WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

it('a post failure after the entry is written answers 500 and leaves nothing behind', async () => {
  const req = request({ 'sb-access-token': adminToken, active_company_id: company }, 'POST') as never as {
    url: string; body: unknown; query: Record<string, string>;
  };
  req.url = '/api/accounting/recurring-journals-action';
  req.query = {};
  req.body = { action: 'generate', id: template };
  const result = response();
  await action(req as never, result.res);

  // Not a 400: withAuth COMMITs anything below 500, which is what let a
  // half-written journal survive the refusal that said it had failed.
  expect(result.state.statusCode).toBe(500);

  const entries = await pool.query(
    "SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source='auto_recurring'", [company]);
  expect(entries.rows).toHaveLength(0);
  const lines = await pool.query('SELECT id FROM gl_journal_lines WHERE company_id=$1', [company]);
  expect(lines.rows).toHaveLength(0);

  // The claim went back with it, so the run is still due rather than silently skipped.
  const tpl = await pool.query(
    'SELECT run_count, next_run_date::text AS next_run_date, status FROM recurring_journals WHERE id=$1', [template]);
  expect(Number(tpl.rows[0].run_count)).toBe(0);
  expect(tpl.rows[0].next_run_date).toBe(today);
  expect(tpl.rows[0].status).toBe('active');
});
