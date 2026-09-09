/**
 * K-049 — the recurring-journal route answers 400 AFTER writing, and withAuth
 * commits the write.
 *
 * recurring-journals-action.ts:46 wraps the whole switch in one try/catch that
 * ends in `apiResponse.badRequestFromError`. withAuth (src/lib/auth/withAuth.ts:224)
 * rolls back only when `res.statusCode >= 500`, so a 400 COMMITs whatever the
 * handler already wrote. generateJournalFromRecurring calls createJournalEntry
 * (which INSERTs the entry and its lines) and only then postJournalEntry, which
 * throws ClosedFiscalPeriodError when the covering period is closed. The caller
 * is told the action failed while a journal entry survives in the books.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import action from '../../pages/api/accounting/recurring-journals-action';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), admin = crypto.randomUUID();
const debitAccount = crypto.randomUUID(), creditAccount = crypto.randomUUID();
const template = crypto.randomUUID();
let adminToken = '';

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K049 recurring journal fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
     VALUES($1,$2,'K049-6000','K049 Rent expense','expense','debit',3,true),
            ($3,$2,'K049-2000','K049 Accruals','liability','credit',3,true)`,
    [debitAccount, company, creditAccount],
  );
  // The period covering today exists and is CLOSED — createJournalEntry resolves
  // it and writes; postJournalEntry then refuses.
  const y = new Date().getUTCFullYear();
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K049 FY',1,$2,$3,$4,'closed')`,
    [company, y, `${y}-01-01`, `${y}-12-31`],
  );
  await pool.query(
    `INSERT INTO recurring_journals(id,company_id,template_name,description,frequency,next_run_date,lines,total_amount,created_by,status)
     VALUES($1,$2,'K049 monthly accrual','K049 monthly accrual','monthly',CURRENT_DATE,$3::jsonb,1000,$4,'active')`,
    [template, company,
      JSON.stringify([
        { glAccountId: debitAccount, debit: 1000, credit: 0, description: 'K049 accrual DR' },
        { glAccountId: creditAccount, debit: 0, credit: 1000, description: 'K049 accrual CR' },
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

it('a failed generate leaves no journal entry behind', async () => {
  const req = request({ 'sb-access-token': adminToken, active_company_id: company }, 'POST') as never as {
    url: string; body: unknown; query: Record<string, string>;
  };
  req.url = '/api/accounting/recurring-journals-action';
  req.query = {};
  req.body = { action: 'generate', id: template };
  const result = response();
  await action(req as never, result.res);

  // The caller is told the action failed.
  expect(result.state.statusCode).toBeGreaterThanOrEqual(400);

  // And nothing it wrote survives.
  const { rows } = await pool.query(
    "SELECT id, status FROM gl_journal_entries WHERE company_id=$1 AND source='auto_recurring'", [company]);
  expect(rows).toHaveLength(0);
});
