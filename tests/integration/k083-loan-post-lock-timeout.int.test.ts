/**
 * K-083 review M5 — the loan row lock that serialises two concurrent posts is
 * bounded.
 *
 * `postPeriodJournals` takes `SELECT … FOR UPDATE` on the loan. Unbounded, a
 * peer holding that row (a long updateLoan, a stalled close) blocks the
 * request until the HTTP/pool timeout and pins a connection; the repo's
 * precedent for a row lock on a ledger write path sets `lock_timeout` to 5s
 * first and maps 55P03 to a retryable error.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import {
  LoanPostLockTimeoutError,
  lockLoanForUpdate,
} from '@/modules/accounting/services/loans/loanPostingGuards';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = randomUUID();
const other = randomUUID();
const loan = randomUUID();
const user = randomUUID();

beforeAll(async () => {
  for (const [id, name] of [[company, 'K083 lock'], [other, 'K083 other']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  const { rows } = await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active)
     VALUES($1,'2400','Loan liability','liability','long_term_liability','credit',true) RETURNING id`,
    [company]);
  await pool.query(
    `INSERT INTO loans(id,company_id,reference,principal,start_date,term_months,rate_mode,fixed_rate,
       gl_account_id,status)
     VALUES($1,$2,'K083-LOCK',100000,'2026-01-31',12,'FIXED',12,$3,'active')`,
    [loan, company, rows[0].id]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM loans WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[company, other]]);
  } finally { await pool.end(); }
});

it('fails fast with a retryable error while a peer holds the loan row', async () => {
  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM loans WHERE id=$1 FOR UPDATE', [loan]);

  const waiter = await pool.connect();
  await waiter.query('BEGIN');
  const started = Date.now();
  try {
    await expect(
      als.run({ client: waiter, userId: user, companyId: company, claims: {} } as never,
        () => lockLoanForUpdate(company, loan)),
    ).rejects.toBeInstanceOf(LoanPostLockTimeoutError);
  } finally {
    await waiter.query('ROLLBACK');
    waiter.release();
    await holder.query('ROLLBACK');
    holder.release();
  }
  const waited = Date.now() - started;
  // Bounded by the 5s lock_timeout, not by the pool or HTTP timeout.
  expect(waited).toBeGreaterThanOrEqual(4_000);
  expect(waited).toBeLessThan(15_000);
});

it('returns null for a loan belonging to another tenant', async () => {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    const row = await als.run(
      { client: c, userId: user, companyId: other, claims: {} } as never,
      () => lockLoanForUpdate(other, loan));
    expect(row).toBeNull();
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

it('returns the loan row when nothing else holds it', async () => {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    const row = await als.run(
      { client: c, userId: user, companyId: company, claims: {} } as never,
      () => lockLoanForUpdate(company, loan));
    expect(row?.reference).toBe('K083-LOCK');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
