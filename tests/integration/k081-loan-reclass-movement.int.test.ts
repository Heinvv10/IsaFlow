/**
 * K-081 — the current-portion reclass must restate a balance, not re-post it.
 *
 * closeLoanPeriod posted DR loan liability / CR current portion for the whole
 * st_liability every month with nothing reversing the previous entry, so after
 * N closes the current-portion account held the sum of N monthly snapshots and
 * the non-current account ran to a debit balance. Three real closes against
 * PostgreSQL, with the journals posted through the GL.
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

interface Tenant {
  company: string;
  loan: string;
  runId: string;
  accounts: Record<string, string>;
}

function tenant(): Tenant {
  return { company: randomUUID(), loan: randomUUID(), runId: randomUUID(), accounts: {} };
}

const A = tenant();
const B = tenant();
const C = tenant();

/** st_liability falls month on month as the twelve-month window shortens. */
const MONTHS = [
  { period: 1, date: '2026-02-28', yyyymm: '202602', closing: 92115.12, st: 100000 },
  { period: 2, date: '2026-03-31', yyyymm: '202603', closing: 84151.39, st: 92000 },
  { period: 3, date: '2026-04-30', yyyymm: '202604', closing: 76108.02, st: 84000 },
];

function run<T>(c: PoolClient, company: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn);
}

async function seed(t: Tenant, label: string) {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [t.company, `K081 ${label}`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [t.company, user]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K081 FY',1,2026,'2026-01-01','2026-12-31','open')`, [t.company]);
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
      [t.company, code, `${label} ${name}`, type, subtype, normal],
    );
    t.accounts[code] = rows[0].id as string;
  }
  await pool.query(
    `INSERT INTO loans(id,company_id,reference,principal,start_date,term_months,rate_mode,fixed_rate,
       gl_account_id,interest_expense_account_id,interest_payable_account_id,bank_account_id,
       current_portion_account_id,status)
     VALUES($1,$2,$3,100000,'2026-01-31',12,'FIXED',12,$4,$5,$6,$7,$8,'active')`,
    [t.loan, t.company, `K081-${label}`, t.accounts['2400'], t.accounts['8100'],
      t.accounts['2420'], t.accounts['1010'], t.accounts['2410']],
  );
  await pool.query(
    `INSERT INTO loan_schedule_runs(id,loan_id,company_id,engine_version,inputs_hash)
     VALUES($1,$2,$3,'test','k081')`, [t.runId, t.loan, t.company]);
  for (const m of MONTHS) {
    await pool.query(
      `INSERT INTO loan_schedule_rows(run_id,period,date,opening,rate,installment,interest,principal,
         lump,skip_flag,payment,closing,st_liability,extrapolated,nca_flagged)
       VALUES($1,$2,$3,100000,12,8884.88,1000,7884.88,0,false,8884.88,$4,$5,false,false)`,
      [t.runId, m.period, m.date, m.closing, m.st]);
  }
}

async function cleanup(t: Tenant) {
  await pool.query('DELETE FROM loan_reclass_postings WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM loan_period_locks WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM loan_gl_postings WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM loan_schedule_rows WHERE run_id=$1', [t.runId]);
  await pool.query('DELETE FROM loan_schedule_runs WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM loans WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [t.company]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1', [t.company]);
  await pool.query('DELETE FROM companies WHERE id=$1', [t.company]);
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await seed(A, 'A');
  await seed(B, 'B');
  await seed(C, 'C');
  // Review H2: tenant C's loan has no current-portion account, so its first
  // close skips the loan and posts nothing — while still locking the month.
  await pool.query(
    'UPDATE loans SET current_portion_account_id = NULL WHERE id=$1', [C.loan]);
});

afterAll(async () => {
  try {
    await cleanup(A);
    await cleanup(B);
    await cleanup(C);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function close(t: Tenant, yyyymm: string) {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    const out = await run(c, t.company, () => closeLoanPeriod(t.company, yyyymm, user));
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally { c.release(); }
}

/** Net credit standing in an account across every posted journal. */
async function balance(company: string, accountId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(l.credit - l.debit),0)::float8 AS net
       FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
      WHERE l.company_id=$1 AND l.gl_account_id=$2 AND e.status='posted'`,
    [company, accountId]);
  return rows[0].net as number;
}

it('leaves the current portion at the latest period figure after three closes', async () => {
  for (const m of MONTHS) await close(A, m.yyyymm);

  const latest = MONTHS[MONTHS.length - 1]!.st;
  expect(await balance(A.company, A.accounts['2410']!)).toBeCloseTo(latest, 2);
  // The matching debit sits on the long-term liability, so the split nets out.
  expect(await balance(A.company, A.accounts['2400']!)).toBeCloseTo(-latest, 2);
});

it('posts only the movement in the second and third months', async () => {
  const { rows } = await pool.query(
    `SELECT e.id, COALESCE(SUM(l.credit),0)::float8 AS cr
       FROM gl_journal_entries e JOIN gl_journal_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id=$1 AND l.gl_account_id=$2
      GROUP BY e.id, e.entry_date ORDER BY e.entry_date`,
    [A.company, A.accounts['2410']]);
  // February reclassifies the full 100,000; March and April post 8,000 each as
  // debits, so their credit total on the current-portion account is zero.
  expect(rows.map((r: { cr: number }) => r.cr)).toEqual([100000, 0, 0]);
});

it('keeps every reclass journal balanced', async () => {
  const { rows } = await pool.query(
    `SELECT e.id, (SUM(l.debit) - SUM(l.credit))::float8 AS diff
       FROM gl_journal_entries e JOIN gl_journal_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id=$1 GROUP BY e.id`, [A.company]);
  expect(rows.length).toBe(3);
  for (const r of rows) expect(r.diff).toBeCloseTo(0, 6);
});

it('leaves the second tenant untouched', async () => {
  expect(await balance(B.company, B.accounts['2410']!)).toBe(0);
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1', [B.company]);
  expect(rows[0].n).toBe(0);

  // Closing B's first period reclassifies its own full amount, unaffected by A.
  await close(B, MONTHS[0]!.yyyymm);
  expect(await balance(B.company, B.accounts['2410']!)).toBeCloseTo(MONTHS[0]!.st, 2);
});

it('reclassifies in full after a close that locked the month but skipped this loan', async () => {
  // Review H2. closeLoanPeriod writes the period lock unconditionally, after
  // the `missing GL accounts`, `no schedule row` and zero-movement skips. When
  // the prior figure was read off any earlier LOCK, this loan supplied a prior
  // of 100,000 for a reclass that never posted, and the next close journalled
  // 92,000 - 100,000 = -8,000: a DEBIT balance of 8,000 on an account that
  // should have held a credit of 92,000, sign inverted and never self-correcting.
  const first = await close(C, MONTHS[0]!.yyyymm);
  expect(first.reclassEntries).toHaveLength(0);
  expect(first.skippedLoans).toEqual([{ loanId: C.loan, reason: 'missing GL accounts' }]);
  expect(await balance(C.company, C.accounts['2410']!)).toBe(0);

  // The month is locked all the same, which is what made the lock unusable as
  // evidence that anything was reclassified.
  const locks = await pool.query(
    'SELECT COUNT(*)::int AS n FROM loan_period_locks WHERE company_id=$1', [C.company]);
  expect(locks.rows[0].n).toBe(1);

  // Nothing was recorded as reclassified, so the next close posts the FULL
  // current portion, not a movement off a balance that was never there.
  await pool.query(
    'UPDATE loans SET current_portion_account_id=$1 WHERE id=$2', [C.accounts['2410'], C.loan]);
  await close(C, MONTHS[1]!.yyyymm);

  expect(await balance(C.company, C.accounts['2410']!)).toBeCloseTo(MONTHS[1]!.st, 2);
  expect(await balance(C.company, C.accounts['2400']!)).toBeCloseTo(-MONTHS[1]!.st, 2);
});

it('records the figure each close reclassified to', async () => {
  const { rows } = await pool.query(
    `SELECT yyyymm, st_liability::float8 AS st FROM loan_reclass_postings
      WHERE company_id=$1 AND loan_id=$2 ORDER BY yyyymm`, [A.company, A.loan]);
  expect(rows.map((r: { yyyymm: string; st: number }) => [r.yyyymm.trim(), r.st]))
    .toEqual(MONTHS.map((m) => [m.yyyymm, m.st]));
});

it('is unmoved by a schedule recomputed between two closes', async () => {
  // Review M3. The prior figure used to come from the LATEST schedule run, so
  // repricing a loan after a close silently restated the earlier month and the
  // difference stuck in the current-portion account for good.
  const before = await balance(C.company, C.accounts['2410']!);

  // A reprice: a newer run gives the ALREADY CLOSED month a different figure.
  const newRun = randomUUID();
  await pool.query(
    `INSERT INTO loan_schedule_runs(id,loan_id,company_id,engine_version,inputs_hash,computed_at)
     VALUES($1,$2,$3,'test','k081-repriced',NOW() + interval '1 hour')`,
    [newRun, C.loan, C.company]);
  for (const m of MONTHS) {
    await pool.query(
      `INSERT INTO loan_schedule_rows(run_id,period,date,opening,rate,installment,interest,principal,
         lump,skip_flag,payment,closing,st_liability,extrapolated,nca_flagged)
       VALUES($1,$2,$3,100000,12,8884.88,1000,7884.88,0,false,8884.88,$4,$5,false,false)`,
      [newRun, m.period, m.date, m.closing, m.st + 25000]);
  }

  await close(C, MONTHS[2]!.yyyymm);

  // The movement is measured against what the previous close actually posted,
  // so the account lands on the new run's figure exactly once.
  const expected = MONTHS[2]!.st + 25000;
  expect(await balance(C.company, C.accounts['2410']!)).toBeCloseTo(expected, 2);
  expect(before).toBeCloseTo(MONTHS[1]!.st, 2);

  await pool.query('DELETE FROM loan_schedule_rows WHERE run_id=$1', [newRun]);
  await pool.query('DELETE FROM loan_schedule_runs WHERE id=$1', [newRun]);
});
