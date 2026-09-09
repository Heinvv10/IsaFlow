/**
 * K-081 review round 2 — M2 (closes must run in order) and L6 (a journal that
 * resolves no fiscal period must not post).
 *
 * M2: the reclass journals only the movement since the previous close, and
 * `fetchPriorReclass` reads the latest EARLIER record. Closing April, then the
 * skipped March, read a prior of 0 for March and posted the FULL current
 * portion; the May close then measured against April's figure and nothing ever
 * unwound March's. The current-portion account stayed permanently over.
 *
 * L6: `createJournalEntry` falls back to a NULL fiscal_period_id outside the
 * auto-create window and `postJournalEntry` skips its closed-period check when
 * it is NULL, so a far-future schedule row posted outside every period report.
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

const MONTHS = [
  { period: 1, date: '2026-03-31', yyyymm: '202603', closing: 92115.12, st: 92000 },
  { period: 2, date: '2026-04-30', yyyymm: '202604', closing: 84151.39, st: 84000 },
  { period: 3, date: '2026-05-31', yyyymm: '202605', closing: 76108.02, st: 76000 },
  // Beyond the +2-year fiscal auto-create window, so no period covers it.
  { period: 4, date: '2032-06-30', yyyymm: '203206', closing: 60000.00, st: 60000 },
];

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K081 ordering']);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",
    [company, user]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K081 FY',1,2026,'2026-01-01','2026-12-31','open')`, [company]);
  for (const [code, name, type, subtype, normal] of [
    ['2400', 'Loan liability', 'liability', 'long_term_liability', 'credit'],
    ['2410', 'Loan current portion', 'liability', 'payable', 'credit'],
    ['8100', 'Interest expense', 'expense', 'default_expense', 'debit'],
    ['2420', 'Interest payable', 'liability', 'payable', 'credit'],
    ['1010', 'Bank', 'asset', 'bank', 'debit'],
  ] as const) {
    const { rows } = await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
         normal_balance,is_active) VALUES($1,$2,$3,$4,$5,$6,true) RETURNING id`,
      [company, code, name, type, subtype, normal]);
    accounts[code] = rows[0].id as string;
  }
  await pool.query(
    `INSERT INTO loans(id,company_id,reference,principal,start_date,term_months,rate_mode,fixed_rate,
       gl_account_id,interest_expense_account_id,interest_payable_account_id,bank_account_id,
       current_portion_account_id,status)
     VALUES($1,$2,'K081-ORD',100000,'2026-02-28',12,'FIXED',12,$3,$4,$5,$6,$7,'active')`,
    [loan, company, accounts['2400'], accounts['8100'], accounts['2420'], accounts['1010'],
      accounts['2410']]);
  await pool.query(
    `INSERT INTO loan_schedule_runs(id,loan_id,company_id,engine_version,inputs_hash)
     VALUES($1,$2,$3,'test','k081ord')`, [runId, loan, company]);
  for (const m of MONTHS) {
    await pool.query(
      `INSERT INTO loan_schedule_rows(run_id,period,date,opening,rate,installment,interest,principal,
         lump,skip_flag,payment,closing,st_liability,extrapolated,nca_flagged)
       VALUES($1,$2,$3,100000,12,8884.88,1000,7884.88,0,false,8884.88,$4,$5,false,false)`,
      [runId, m.period, m.date, m.closing, m.st]);
  }
});

afterAll(async () => {
  try {
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
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function close(yyyymm: string) {
  const c: PoolClient = await pool.connect();
  await c.query('BEGIN');
  try {
    const out = await als.run(
      { client: c, userId: user, companyId: company, claims: {} } as never,
      () => closeLoanPeriod(company, yyyymm, user));
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally { c.release(); }
}

async function balance(accountId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(l.credit - l.debit),0)::float8 AS net
       FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
      WHERE l.company_id=$1 AND l.gl_account_id=$2 AND e.status='posted'`, [company, accountId]);
  return rows[0].net as number;
}

it('refuses a close of a month earlier than one already closed (M2)', async () => {
  await close(MONTHS[1]!.yyyymm);
  expect(await balance(accounts['2410']!)).toBeCloseTo(MONTHS[1]!.st, 2);

  // Without the guard this posted the full 92 000 on top of April's 84 000 and
  // no later close ever unwound it.
  await expect(close(MONTHS[0]!.yyyymm)).rejects.toThrow(/ascending order/);

  expect(await balance(accounts['2410']!)).toBeCloseTo(MONTHS[1]!.st, 2);
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM loan_period_locks WHERE company_id=$1', [company]);
  expect(rows[0].n).toBe(1);
});

it('still allows the next month in sequence', async () => {
  await close(MONTHS[2]!.yyyymm);
  // Only the movement, so the account holds May's figure exactly once.
  expect(await balance(accounts['2410']!)).toBeCloseTo(MONTHS[2]!.st, 2);
  expect(await balance(accounts['2400']!)).toBeCloseTo(-MONTHS[2]!.st, 2);
});

it('refuses to post a reclass whose date resolves no fiscal period (L6)', async () => {
  await expect(close(MONTHS[3]!.yyyymm)).rejects.toThrow(/outside every fiscal period/);

  // The throw rolls the whole close back: no journal, no lock, no record.
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM gl_journal_entries WHERE company_id=$1
              AND fiscal_period_id IS NULL)::int AS orphans,
            (SELECT COUNT(*) FROM loan_period_locks WHERE company_id=$1)::int AS locks`,
    [company]);
  expect(rows[0].orphans).toBe(0);
  expect(rows[0].locks).toBe(2);
});

/**
 * Round-3 M4. `assertClosesInOrder` is a read-then-act check: the later-lock
 * read and the `loan_period_locks` INSERT that would satisfy it sit either side
 * of every journal post, and the table's PK only stops the SAME month twice.
 * Two concurrent closes of adjacent months therefore both read an empty
 * later-lock set and both post their FULL current portion off a prior of 0.
 * The advisory lock serialises them, so whichever order they land in, the
 * current-portion account holds ONE month's figure — never the sum.
 */
it('serialises two concurrent closes of adjacent months (M4)', async () => {
  const co = randomUUID();
  const ln = randomUUID();
  const run = randomUUID();
  const acct: Record<string, string> = {};
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [co, 'K081 M4']);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",
    [co, user]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K081 M4 FY',1,2026,'2026-01-01','2026-12-31','open')`, [co]);
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
      [co, code, type, subtype, normal]);
    acct[code] = rows[0].id as string;
  }
  await pool.query(
    `INSERT INTO loans(id,company_id,reference,principal,start_date,term_months,rate_mode,fixed_rate,
       gl_account_id,interest_expense_account_id,interest_payable_account_id,bank_account_id,
       current_portion_account_id,status)
     VALUES($1,$2,'K081-M4',100000,'2026-02-28',12,'FIXED',12,$3,$4,$5,$6,$7,'active')`,
    [ln, co, acct['2400'], acct['8100'], acct['2420'], acct['1010'], acct['2410']]);
  await pool.query(
    `INSERT INTO loan_schedule_runs(id,loan_id,company_id,engine_version,inputs_hash)
     VALUES($1,$2,$3,'test','k081m4')`, [run, ln, co]);
  for (const m of MONTHS.slice(0, 2)) {
    await pool.query(
      `INSERT INTO loan_schedule_rows(run_id,period,date,opening,rate,installment,interest,principal,
         lump,skip_flag,payment,closing,st_liability,extrapolated,nca_flagged)
       VALUES($1,$2,$3,100000,12,8884.88,1000,7884.88,0,false,8884.88,$4,$5,false,false)`,
      [run, m.period, m.date, m.closing, m.st]);
  }

  async function closeFor(yyyymm: string) {
    const c: PoolClient = await pool.connect();
    await c.query('BEGIN');
    try {
      const out = await als.run(
        { client: c, userId: user, companyId: co, claims: {} } as never,
        () => closeLoanPeriod(co, yyyymm, user));
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally { c.release(); }
  }

  async function cpBalance(): Promise<number> {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(l.credit - l.debit),0)::float8 AS net
         FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
        WHERE l.company_id=$1 AND l.gl_account_id=$2 AND e.status='posted'`, [co, acct['2410']]);
    return rows[0].net as number;
  }

  try {
    // A peer close of this company is represented by a second client holding
    // the same advisory lock. The close must WAIT for it — not read the
    // later-lock set and carry on, which is what made the guard bypassable.
    const holder: PoolClient = await pool.connect();
    await holder.query('BEGIN');
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtext($1::text || ':loan_period_close'))", [co]);

    let settled = false;
    const pending = closeFor(MONTHS[0]!.yyyymm)
      .then((r) => { settled = true; return r; }, (e) => { settled = true; throw e; });

    await new Promise((r) => setTimeout(r, 750));
    expect(settled).toBe(false);
    expect(await cpBalance()).toBeCloseTo(0, 2);

    await holder.query('COMMIT');
    holder.release();
    await pending;
    expect(settled).toBe(true);
    expect(await cpBalance()).toBeCloseTo(MONTHS[0]!.st, 2);

    // And the next month still posts the movement only, never the sum.
    await closeFor(MONTHS[1]!.yyyymm);
    expect(await cpBalance()).toBeCloseTo(MONTHS[1]!.st, 2);
    expect(await cpBalance()).not.toBeCloseTo(MONTHS[0]!.st + MONTHS[1]!.st, 2);
  } finally {
    await pool.query('DELETE FROM loan_reclass_postings WHERE company_id=$1', [co]);
    await pool.query('DELETE FROM loan_period_locks WHERE company_id=$1', [co]);
    await pool.query('DELETE FROM loan_schedule_rows WHERE run_id=$1', [run]);
    await pool.query('DELETE FROM loan_schedule_runs WHERE company_id=$1', [co]);
    await pool.query('DELETE FROM loans WHERE company_id=$1', [co]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [co]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [co]);
    await pool.query(
      'DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)',
      [co]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [co]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [co]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [co]);
    await pool.query('DELETE FROM companies WHERE id=$1', [co]);
  }
}, 30_000);
