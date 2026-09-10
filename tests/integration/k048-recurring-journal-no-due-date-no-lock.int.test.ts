/**
 * K-048 — recurring journal generation has no due-date test and no lock.
 *
 * generateJournalFromRecurring (recurringJournalService.ts:77-108) reads the
 * template with a plain SELECT (no FOR UPDATE), checks only status='active',
 * and posts unconditionally. next_run_date is never compared to today, so a
 * template scheduled for a future date posts on demand; and because nothing is
 * locked or keyed for idempotency, repeated calls each mint another posted
 * journal while advancing next_run_date one interval per call.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inRequestTx } from './recurringJournalRequestTx.helpers';
import { generateJournalFromRecurring } from '../../src/modules/accounting/services/gl/recurringJournalService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const debitAccount = crypto.randomUUID(), creditAccount = crypto.randomUUID();
const template = crypto.randomUUID();
const today = new Date();
const futureRunDate = `${today.getFullYear() + 1}-06-01`;

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K048 recurring journal fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
     VALUES($1,$2,'K048-6000','K048 Rent expense','expense','debit',3,true),
            ($3,$2,'K048-2000','K048 Accruals','liability','credit',3,true)`,
    [debitAccount, company, creditAccount],
  );
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     SELECT $1,'K048 ' || to_char(d,'Mon YYYY'), EXTRACT(MONTH FROM d)::int, EXTRACT(YEAR FROM d)::int,
            d, (d + INTERVAL '1 month - 1 day')::date, 'open'
     FROM generate_series(date_trunc('year', CURRENT_DATE), date_trunc('year', CURRENT_DATE) + INTERVAL '23 months', INTERVAL '1 month') d`,
    [company],
  );
  await pool.query(
    `INSERT INTO recurring_journals(id,company_id,template_name,description,frequency,next_run_date,lines,total_amount,created_by,status)
     VALUES($1,$2,'K048 monthly accrual','K048 monthly accrual','monthly',$3::date,$4::jsonb,1000,$5,'active')`,
    [template, company, futureRunDate,
      JSON.stringify([
        { glAccountId: debitAccount, debit: 1000, credit: 0, description: 'K048 accrual DR' },
        { glAccountId: creditAccount, debit: 0, credit: 1000, description: 'K048 accrual CR' },
      ]), user],
  );
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM recurring_journals WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('refuses to generate a recurring journal whose next_run_date has not arrived', async () => {
  // Matched on the message, not on "some error": an unmatched rejects.toThrow()
  // here passes on a connection failure or a typo as readily as on the refusal
  // this test is named for.
  await expect(
    inRequestTx(pool, company, user, () => generateJournalFromRecurring(company, template, user)),
  ).rejects.toThrow(/not due until/i);

  const posted = await pool.query(
    "SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='auto_recurring'", [company]);
  expect(posted.rows[0].n).toBe(0);
});

it('generates at most one journal per scheduled run, however often it is called', async () => {
  // The SAST date, not CURRENT_DATE: the guard compares against
  // `(NOW() AT TIME ZONE 'Africa/Johannesburg')::DATE`, and for the first two
  // hours of the SAST day the UTC date is yesterday's.
  await pool.query(
    `UPDATE recurring_journals SET next_run_date=(NOW() AT TIME ZONE 'Africa/Johannesburg')::DATE,
            run_count=0, last_run_date=NULL WHERE id=$1`, [template]);
  await pool.query("DELETE FROM gl_journal_lines WHERE company_id=$1", [company]);
  await pool.query("DELETE FROM gl_journal_entries WHERE company_id=$1", [company]);

  await inRequestTx(pool, company, user, () => generateJournalFromRecurring(company, template, user));
  await inRequestTx(pool, company, user, () => generateJournalFromRecurring(company, template, user))
    .catch(() => undefined);

  const posted = await pool.query(
    "SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='auto_recurring'", [company]);
  expect(posted.rows[0].n).toBe(1);
});
