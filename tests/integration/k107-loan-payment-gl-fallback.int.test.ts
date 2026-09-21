/**
 * K-107 round 7 — `services/loans` was outside the round-6 census set.
 *
 * `loanPaymentService.glByCode` selected `gl_accounts WHERE ... code = $2`.
 * `gl_accounts` has no `code` column — it is `account_code` — so every fallback
 * lookup raised 42703 (`column "code" does not exist`), which also POISONS the
 * request transaction, turning a recoverable "loan has no interest account, use
 * 5700" into an opaque 500 for the whole request. `taxDirectivePaymentService`
 * carried the byte-identical helper and the same defect; both are fixed.
 *
 * Proved by outcome on the path that reaches the fallback: a loan with neither
 * `interest_expense_account_id` nor `bank_account_id` set, and no override.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { recordLoanPayment } from '../../src/modules/accounting/services/loans/loanPaymentService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const loanAccount = crypto.randomUUID(), interestAccount = crypto.randomUUID(), bank = crypto.randomUUID();
const loan = crypto.randomUUID(), run = crypto.randomUUID();

const ctxFor = (client: PoolClient) =>
  ({ client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0]);

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run(ctxFor(client), fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 R7 loan fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active)
     VALUES($1,$2,'2300','Loan Payable','liability','other','credit',true),
            ($3,$2,'5700','Bank Charges','expense','other','debit',true),
            ($4,$2,'1110','Bank - Primary','asset','bank','debit',true)`,
    [loanAccount, company, interestAccount, bank]);
  // interest_expense_account_id and bank_account_id deliberately NULL: that is
  // the only path that reaches glByCode.
  await pool.query(
    `INSERT INTO loans(id,company_id,gl_account_id,reference,principal,start_date,term_months,
                       rate_mode,fixed_rate,status)
     VALUES($1,$2,$3,'K107R7-LOAN',120000,'2026-01-01',12,'FIXED',0.10,'active')`,
    [loan, company, loanAccount]);
  await pool.query(
    `INSERT INTO loan_schedule_runs(id,loan_id,company_id,computed_at,engine_version,inputs_hash)
     VALUES($1,$2,$3,NOW(),'k107r7','k107r7')`,
    [run, loan, company]);
  await pool.query(
    `INSERT INTO loan_schedule_rows(run_id,period,date,opening,rate,installment,interest,principal,closing)
     VALUES($1,1,'2026-02-01',120000,0.10,10500,1000,9500,110500)`, [run]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM loan_payments WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM loan_schedule_rows WHERE run_id=$1', [run]);
    await pool.query('DELETE FROM loan_schedule_runs WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM loans WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('resolves the 5700 / 1110 fallbacks and posts a balanced loan-payment journal', async () => {
  const result = await inTx(() => recordLoanPayment(company, loan, { paymentDate: '2026-02-01', periodNumber: 1 }, user));
  expect.soft(result.interest).toBeCloseTo(1000, 2);
  expect.soft(result.principal).toBeCloseTo(9500, 2);
  expect.soft(result.totalPaid).toBeCloseTo(10500, 2);

  const je = await pool.query(
    `SELECT je.status, je.fiscal_period_id, COALESCE(SUM(jl.debit),0) dr, COALESCE(SUM(jl.credit),0) cr
       FROM gl_journal_entries je JOIN gl_journal_lines jl ON jl.journal_entry_id=je.id
      WHERE je.id=$1 GROUP BY je.id, je.status, je.fiscal_period_id`, [result.journalEntryId]);
  expect.soft(je.rows[0].status).toBe('posted');
  expect.soft(je.rows[0].fiscal_period_id).not.toBeNull();
  expect.soft(Number(je.rows[0].dr)).toBeCloseTo(10500, 2);
  expect.soft(Number(je.rows[0].cr)).toBeCloseTo(10500, 2);

  // The fallbacks actually resolved to the accounts glByCode was meant to find.
  const lines = await pool.query(
    'SELECT gl_account_id, debit, credit FROM gl_journal_lines WHERE journal_entry_id=$1', [result.journalEntryId]);
  const byAccount = new Map(lines.rows.map((r) => [r.gl_account_id, r]));
  expect.soft(Number(byAccount.get(interestAccount)?.debit)).toBeCloseTo(1000, 2);
  expect(Number(byAccount.get(bank)?.credit)).toBeCloseTo(10500, 2);
});
