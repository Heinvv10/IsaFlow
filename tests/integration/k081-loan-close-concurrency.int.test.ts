/**
 * K-081 review round 4 — M1 and M2, the two ways the close's serialisation
 * could be present in the source and absent at run time.
 *
 * M1: `assertClosesInOrder` takes `pg_advisory_xact_lock`, which is released at
 * the end of the transaction it was taken in. Outside a request transaction
 * `sql` runs on a pooled connection in its own implicit transaction, so the
 * lock was taken and released in the same statement and every close read the
 * later-lock set concurrently again — the guard looked present and serialised
 * nothing. It now refuses, the way `lockLoanForUpdate` does.
 *
 * M2: `closeLoanPeriod` read `isPeriodLocked` BEFORE taking that lock, so two
 * concurrent closes of the SAME month both saw it unlocked. The second then
 * re-created and re-posted every reclass journal for the month and only failed
 * on the `loan_period_locks` PK, ~60 lines and several GL posts later — a raw
 * 23505 instead of the named error, with the whole month's work done twice.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { closeLoanPeriod } from '@/modules/accounting/services/loans/loanPeriodCloseService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const user = randomUUID();
const company = randomUUID();
const loan = randomUUID();
const runId = randomUUID();
const accounts: Record<string, string> = {};
const YYYYMM = '202603';
const ST = 92000;

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K081 concurrency']);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",
    [company, user]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K081 conc FY',1,2026,'2026-01-01','2026-12-31','open')`, [company]);
  for (const [code, type, subtype, normal] of [
    ['2400', 'liability', 'long_term_liability', 'credit'],
    ['2410', 'liability', 'payable', 'credit'],
    ['8100', 'expense', 'default_expense', 'debit'],
    ['2420', 'liability', 'payable', 'credit'],
    ['1010', 'asset', 'bank', 'debit'],
  ] as const) {
    const { rows } = await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
         normal_balance,is_active) VALUES($1,$2,$2,$3,$4,$5,true) RETURNING id`,
      [company, code, type, subtype, normal]);
    accounts[code] = rows[0].id as string;
  }
  await pool.query(
    `INSERT INTO loans(id,company_id,reference,principal,start_date,term_months,rate_mode,fixed_rate,
       gl_account_id,interest_expense_account_id,interest_payable_account_id,bank_account_id,
       current_portion_account_id,status)
     VALUES($1,$2,'K081-CONC',100000,'2026-02-28',12,'FIXED',12,$3,$4,$5,$6,$7,'active')`,
    [loan, company, accounts['2400'], accounts['8100'], accounts['2420'], accounts['1010'],
      accounts['2410']]);
  await pool.query(
    `INSERT INTO loan_schedule_runs(id,loan_id,company_id,engine_version,inputs_hash)
     VALUES($1,$2,$3,'test','k081conc')`, [runId, loan, company]);
  await pool.query(
    `INSERT INTO loan_schedule_rows(run_id,period,date,opening,rate,installment,interest,principal,
       lump,skip_flag,payment,closing,st_liability,extrapolated,nca_flagged)
     VALUES($1,1,'2026-03-31',100000,12,8884.88,1000,7884.88,0,false,8884.88,92115.12,$2,false,false)`,
    [runId, ST]);
}, 60_000);

afterAll(async () => {
  await pool.query('DELETE FROM loan_reclass_postings WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM loan_period_locks WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM loan_schedule_rows WHERE run_id=$1', [runId]);
  await pool.query('DELETE FROM loan_schedule_runs WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM loans WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
  await pool.query(
    'DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)',
    [company]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  await pool.end();
}, 60_000);

/** One close on its own pooled client, in a real request transaction. */
async function closeInTx(yyyymm: string): Promise<void> {
  const c: PoolClient = await pool.connect();
  await c.query('BEGIN');
  try {
    await als.run({ client: c, userId: user, companyId: company, claims: {} } as never,
      () => closeLoanPeriod(company, yyyymm, user));
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally { c.release(); }
}

async function counts(): Promise<{ journals: number; locks: number; cp: number }> {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM gl_journal_entries WHERE company_id=$1)::int AS journals,
            (SELECT COUNT(*) FROM loan_period_locks WHERE company_id=$1)::int  AS locks,
            (SELECT COALESCE(SUM(l.credit - l.debit),0)::float8
               FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
              WHERE l.company_id=$1 AND l.gl_account_id=$2 AND e.status='posted') AS cp`,
    [company, accounts['2410']]);
  return rows[0] as { journals: number; locks: number; cp: number };
}

/**
 * M1. Without a request transaction there is no transaction for the advisory
 * lock to live in. Refuse rather than degrade — and prove nothing was written
 * on the way out.
 */
it('refuses to close outside a request transaction (M1)', async () => {
  const before = await counts();
  await expect(closeLoanPeriod(company, YYYYMM, user))
    .rejects.toThrow(/assertClosesInOrder requires a request transaction/);
  expect(await counts()).toEqual(before);
});

/**
 * M2. Two closes of the same month, started together. Exactly one wins; the
 * loser is refused by name, and — the part the PK could not give — it never
 * posts a second round of journals for the month.
 */
it('answers the second concurrent close of the SAME month by name, before it posts (M2)', async () => {
  const before = await counts();
  const results = await Promise.allSettled([closeInTx(YYYYMM), closeInTx(YYYYMM)]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  expect(ok).toHaveLength(1);
  expect(failed).toHaveLength(1);
  expect(String(failed[0]!.reason?.message ?? failed[0]!.reason))
    .toMatch(new RegExp(`Period ${YYYYMM} is already locked`));

  const after = await counts();
  expect(after.locks).toBe(before.locks + 1);
  // One reclass journal for the month, not two: the loser was stopped under the
  // lock, before it created anything.
  expect(after.journals).toBe(before.journals + 1);
  // And the current-portion account holds the month's figure, never the sum.
  expect(after.cp).toBeCloseTo(ST, 2);
  expect(after.cp).not.toBeCloseTo(ST * 2, 2);
});

/** The loser's rejection is the named error even when it arrives second in time. */
it('still refuses a later close of the same month once it is locked', async () => {
  await expect(closeInTx(YYYYMM)).rejects.toThrow(new RegExp(`Period ${YYYYMM} is already locked`));
});
