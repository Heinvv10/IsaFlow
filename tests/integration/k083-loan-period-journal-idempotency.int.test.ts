/**
 * K-083 RED. `postPeriodJournals`
 * (git show origin/master:src/modules/accounting/services/loans/loanGlPostingService.ts,
 * lines 146-207) checks the loan exists, the schedule row exists, the NCA flag
 * and the period lock — and then posts. It never asks whether this loan/period
 * already has a journal, `loan_gl_postings` carries no unique key over
 * (company_id, loan_id, period) (only two plain btree indexes), and nothing
 * takes a row lock.
 *
 * So calling the endpoint twice for the same period — POST
 * /api/accounting/loans/[id]/gl-postings, or a re-run of
 * /api/accounting/loans/period-close — posts the interest and capital journals
 * twice: interest expense and the loan liability are both doubled.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { postPeriodJournals } from '@/modules/accounting/services/loans/loanGlPostingService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = randomUUID();
const user = randomUUID();
const loan = randomUUID();
const runId = randomUUID();
const accounts: Record<string, string> = {};
// A second tenant posting the same loan period must be untouched by the guard.
const companyB = randomUUID();
const loanB = randomUUID();
const runIdB = randomUUID();
const accountsB: Record<string, string> = {};

function run<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn);
}

async function account(code: string, name: string, type: string, subtype: string, normal: string) {
  const { rows } = await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active) VALUES($1,$2,$3,$4,$5,$6,true) RETURNING id`,
    [company, code, name, type, subtype, normal],
  );
  accounts[code] = rows[0].id as string;
}

async function accountB(code: string, name: string, type: string, subtype: string, normal: string) {
  const { rows } = await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active) VALUES($1,$2,$3,$4,$5,$6,true) RETURNING id`,
    [companyB, code, name, type, subtype, normal],
  );
  accountsB[code] = rows[0].id as string;
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K083 loan fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K083 FY',1,2026,'2026-01-01','2026-12-31','open')`, [company]);
  await account('2400', 'K083 Loan liability', 'liability', 'long_term_liability', 'credit');
  await account('2410', 'K083 Loan current portion', 'liability', 'payable', 'credit');
  await account('8100', 'K083 Interest expense', 'expense', 'default_expense', 'debit');
  await account('2420', 'K083 Interest payable', 'liability', 'payable', 'credit');
  await account('1010', 'K083 Bank', 'asset', 'bank', 'debit');
  await pool.query(
    `INSERT INTO loans(id,company_id,reference,principal,start_date,term_months,rate_mode,fixed_rate,
       gl_account_id,interest_expense_account_id,interest_payable_account_id,bank_account_id,
       current_portion_account_id,status)
     VALUES($1,$2,'K083-LOAN',100000,'2026-01-31',12,'FIXED',12,$3,$4,$5,$6,$7,'active')`,
    [loan, company, accounts['2400'], accounts['8100'], accounts['2420'], accounts['1010'], accounts['2410']],
  );
  await pool.query(
    `INSERT INTO loan_schedule_runs(id,loan_id,company_id,engine_version,inputs_hash)
     VALUES($1,$2,$3,'test','k083')`, [runId, loan, company]);
  await pool.query(
    `INSERT INTO loan_schedule_rows(run_id,period,date,opening,rate,installment,interest,principal,
       lump,skip_flag,payment,closing,st_liability,extrapolated,nca_flagged)
     VALUES($1,1,'2026-02-28',100000,12,8884.88,1000,7884.88,0,false,8884.88,92115.12,92115.12,false,false),
           ($1,2,'2026-03-31',92115.12,12,8884.88,921.15,7963.73,0,false,8884.88,84151.39,84151.39,false,false),
           ($1,3,'2026-04-30',84151.39,12,8884.88,841.51,8043.37,0,false,8884.88,76108.02,76108.02,false,false)`,
    [runId]);

  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K083 loan fixture B')", [companyB]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [companyB, user]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K083 FY B',1,2026,'2026-01-01','2026-12-31','open')`, [companyB]);
  await accountB('2400', 'K083B Loan liability', 'liability', 'long_term_liability', 'credit');
  await accountB('2410', 'K083B Loan current portion', 'liability', 'payable', 'credit');
  await accountB('8100', 'K083B Interest expense', 'expense', 'default_expense', 'debit');
  await accountB('2420', 'K083B Interest payable', 'liability', 'payable', 'credit');
  await accountB('1010', 'K083B Bank', 'asset', 'bank', 'debit');
  await pool.query(
    `INSERT INTO loans(id,company_id,reference,principal,start_date,term_months,rate_mode,fixed_rate,
       gl_account_id,interest_expense_account_id,interest_payable_account_id,bank_account_id,
       current_portion_account_id,status)
     VALUES($1,$2,'K083B-LOAN',100000,'2026-01-31',12,'FIXED',12,$3,$4,$5,$6,$7,'active')`,
    [loanB, companyB, accountsB['2400'], accountsB['8100'], accountsB['2420'], accountsB['1010'], accountsB['2410']],
  );
  await pool.query(
    `INSERT INTO loan_schedule_runs(id,loan_id,company_id,engine_version,inputs_hash)
     VALUES($1,$2,$3,'test','k083b')`, [runIdB, loanB, companyB]);
  await pool.query(
    `INSERT INTO loan_schedule_rows(run_id,period,date,opening,rate,installment,interest,principal,
       lump,skip_flag,payment,closing,st_liability,extrapolated,nca_flagged)
     VALUES($1,1,'2026-02-28',100000,12,8884.88,1000,7884.88,0,false,8884.88,92115.12,92115.12,false,false)`,
    [runIdB]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM loan_gl_postings WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM loan_schedule_rows WHERE run_id=$1', [runId]);
    await pool.query('DELETE FROM loan_schedule_runs WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM loans WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    for (const c of [companyB]) {
      await pool.query('DELETE FROM loan_gl_postings WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM loan_schedule_rows WHERE run_id=$1', [runIdB]);
      await pool.query('DELETE FROM loan_schedule_runs WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM loans WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [c]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM company_users WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM companies WHERE id=$1', [c]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function postPeriod(period = 1, forCompany = company, forLoan = loan) {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    const out = await run(c, () => postPeriodJournals(forCompany, forLoan, period, user));
    await c.query('COMMIT');
    return { ok: true as const, out };
  } catch (err) {
    await c.query('ROLLBACK');
    return { ok: false as const, err };
  } finally {
    c.release();
  }
}

it('posting the same loan period twice leaves one journal, not two', async () => {
  const first = await postPeriod();
  expect(first.ok).toBe(true);

  const second = await postPeriod();
  // Refusing the repeat or returning the existing entry are both fine; posting
  // a second set of journals is not.
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(l.debit),0)::float8 AS interest_debited
       FROM gl_journal_lines l JOIN gl_accounts a ON a.id=l.gl_account_id
      WHERE l.company_id=$1 AND a.account_code='8100'`, [company]);
  expect(rows[0].interest_debited).toBe(1000);

  const posts = await pool.query(
    'SELECT COUNT(DISTINCT journal_entry_id)::int AS n FROM loan_gl_postings WHERE company_id=$1 AND loan_id=$2 AND period=1',
    [company, loan]);
  expect(posts.rows[0].n).toBe(1);
  expect(second.ok).toBe(false);
  // The service refuses it by name. Falling through to the exclusion constraint
  // would also keep the ledger right, but surfaces an opaque 23P01 to the caller.
  expect(String((second as { err: unknown }).err)).toMatch(/has already been posted/);
});

it('leaves a second tenant free to post the same period on its own loan', async () => {
  const b = await postPeriod(1, companyB, loanB);
  expect(b.ok).toBe(true);

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(l.debit),0)::float8 AS interest_debited
       FROM gl_journal_lines l JOIN gl_accounts a ON a.id=l.gl_account_id
      WHERE l.company_id=$1 AND a.account_code='8100'`, [companyB]);
  expect(rows[0].interest_debited).toBe(1000);

  // Company A's ledger is untouched by company B's post.
  const a = await pool.query(
    `SELECT COALESCE(SUM(l.debit),0)::float8 AS interest_debited
       FROM gl_journal_lines l JOIN gl_accounts a ON a.id=l.gl_account_id
      WHERE l.company_id=$1 AND a.account_code='8100'`, [company]);
  expect(a.rows[0].interest_debited).toBe(1000);
});

it('does not treat a reversal row as an existing post', async () => {
  // A reversal set carries reversal_of; it must not block period 2.
  const seed = await pool.query(
    `SELECT id FROM loan_gl_postings WHERE company_id=$1 AND loan_id=$2 AND period=1 LIMIT 1`,
    [company, loan]);
  await pool.query(
    `INSERT INTO loan_gl_postings(company_id,loan_id,period,posting_date,account_id,debit,credit,
       narrative,posted_period,journal_entry_id,reversal_of)
     VALUES($1,$2,2,'2026-03-31',$3,0,921.15,'reversal','202603',NULL,$4)`,
    [company, loan, accounts['8100'], seed.rows[0].id]);

  const posted = await postPeriod(2);
  expect(posted.ok).toBe(true);

  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT journal_entry_id)::int AS n FROM loan_gl_postings
      WHERE company_id=$1 AND loan_id=$2 AND period=2 AND reversal_of IS NULL`, [company, loan]);
  expect(rows[0].n).toBe(1);
});

it('lets only one of two concurrent posts through', async () => {
  const [first, second] = await Promise.all([postPeriod(3), postPeriod(3)]);
  const outcomes = [first.ok, second.ok].sort();
  expect(outcomes).toEqual([false, true]);

  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT journal_entry_id)::int AS n FROM loan_gl_postings
      WHERE company_id=$1 AND loan_id=$2 AND period=3 AND reversal_of IS NULL`, [company, loan]);
  expect(rows[0].n).toBe(1);

  // Interest expense carries period 1 + period 2 + period 3 exactly once each.
  const gl = await pool.query(
    `SELECT COALESCE(SUM(l.debit),0)::float8 AS interest_debited
       FROM gl_journal_lines l JOIN gl_accounts a ON a.id=l.gl_account_id
      WHERE l.company_id=$1 AND a.account_code='8100'`, [company]);
  expect(gl.rows[0].interest_debited).toBeCloseTo(1000 + 921.15 + 841.51, 2);
});
