// K-020 adjacent cases for the live recompute in updateReconciledBalance:
//   * matching a bank transaction must NOT move the balance (the movement it
//     confirms is already in the GL),
//   * another tenant's journal line on the same gl_account_id is excluded,
//   * a posted entry dated after statement_date is excluded, one dated exactly
//     on statement_date is included,
//   * a draft (unposted) entry is excluded,
//   * an adjustment against a different bank account, or against a completed
//     reconciliation, is refused rather than posted with no effect.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  createAdjustmentEntry,
  startReconciliation,
  updateReconciledBalance,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import { insertPreConstraintRow } from './helpers/preConstraintRow';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
const otherUser = crypto.randomUUID();
const bank = crypto.randomUUID();
const contra = crypto.randomUUID();
const period = crypto.randomUUID();
const otherPeriod = crypto.randomUUID();
const onDateJe = crypto.randomUUID();
const bankLine = crypto.randomUUID();
const bankTx = crypto.randomUUID();
const otherBank = crypto.randomUUID();
let reconId = '';

async function countEntries(): Promise<number> {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1', [company]);
  return r.rows[0].n as number;
}

async function seedEntry(
  id: string, co: string, byUser: string, fiscalPeriod: string,
  date: string, status: string, amount: number,
  bankLineId = crypto.randomUUID(),
): Promise<void> {
  const posted = status === 'posted';
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by,fiscal_period_id,posted_at,posted_by)
     VALUES($1,$2,$3::date,'K020 seed',$4,$5,$6,${posted ? 'NOW()' : 'NULL'},${posted ? '$5' : 'NULL'})`,
    [id, co, date, status, byUser, fiscalPeriod],
  );
  // `co` is deliberately the OTHER tenant for one seed while the accounts stay
  // this company's — the cross-company shape migration 660 now refuses, and the
  // pre-660 shape this test exists to prove is not counted.
  await insertPreConstraintRow(
    pool,
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$2,$3,$4,$5,0),($6,$2,$3,$7,0,$5)`,
    [bankLineId, co, id, bank, amount, crypto.randomUUID(), contra],
  );
}

beforeAll(async () => {
  for (const [id, name] of [[company, 'K020 recompute fixture'], [other, 'K020 other tenant']]) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  for (const [u, co] of [[user, company], [otherUser, other]]) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [u, `${u}@test.local`]);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [co, u]);
  }
  for (const [p, co] of [[period, company], [otherPeriod, other]]) {
    await pool.query(
      `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
       VALUES($1,$2,'K020 Mar 2026',3,2026,DATE '2026-03-01',DATE '2026-03-31','open')`,
      [p, co],
    );
  }
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
     VALUES($1,$3,'K020RB','K020 Bank','asset','bank','debit'),($2,$3,'K020RC','K020 Contra','revenue',NULL,'credit'),
            ($4,$3,'K020RB2','K020 Second Bank','asset','bank','debit')`,
    [bank, contra, company, otherBank],
  );
  // In period, posted, on the statement date itself: must be included.
  await seedEntry(onDateJe, company, user, period, '2026-03-31', 'posted', 400, bankLine);
  // Posted but dated after the statement date: must be excluded.
  await seedEntry(crypto.randomUUID(), company, user, period, '2026-04-02', 'posted', 700);
  // Draft, in date: must be excluded.
  await seedEntry(crypto.randomUUID(), company, user, period, '2026-03-10', 'draft', 900);
  // Another tenant's line on THIS company's bank account: must be excluded.
  await seedEntry(crypto.randomUUID(), other, otherUser, otherPeriod, '2026-03-10', 'posted', 300);

  const recon = await startReconciliation(company, bank, '2026-03-31', 400, user);
  reconId = recon.id;
});

afterAll(async () => {
  try {
    for (const co of [company, other]) {
      await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM bank_reconciliations WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [co]);
    }
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [[bank, contra, otherBank]]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    for (const co of [company, other]) {
      await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM company_users WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM companies WHERE id=$1', [co]);
    }
    for (const u of [user, otherUser]) await pool.query('DELETE FROM users WHERE id=$1', [u]);
  } finally {
    await pool.end();
  }
});

describe('K-020 reconciled balance recompute', () => {
  it('counts only this tenant, posted entries, dated on or before statement_date', async () => {
    await updateReconciledBalance(company, reconId);
    const row = await pool.query(
      'SELECT gl_balance, reconciled_balance, difference FROM bank_reconciliations WHERE id=$1', [reconId]);
    expect(Number(row.rows[0].gl_balance)).toBe(400);
    expect(Number(row.rows[0].reconciled_balance)).toBe(400);
    expect(Number(row.rows[0].difference)).toBe(0);
  });

  it('does not move the balance when a transaction becomes matched', async () => {
    await pool.query(
      `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,reconciliation_id,matched_journal_line_id)
       VALUES($1,$2,$3,DATE '2026-03-31',400,'K020 matched receipt','matched',$4,$5)`,
      [bankTx, company, bank, reconId, bankLine],
    );
    await updateReconciledBalance(company, reconId);
    const row = await pool.query(
      'SELECT reconciled_balance, difference FROM bank_reconciliations WHERE id=$1', [reconId]);
    expect(Number(row.rows[0].reconciled_balance)).toBe(400);
    expect(Number(row.rows[0].difference)).toBe(0);
  });

  it('leaves the row untouched when called with the wrong company_id', async () => {
    await updateReconciledBalance(other, reconId);
    const row = await pool.query(
      'SELECT gl_balance, reconciled_balance FROM bank_reconciliations WHERE id=$1', [reconId]);
    expect(Number(row.rows[0].gl_balance)).toBe(400);
    expect(Number(row.rows[0].reconciled_balance)).toBe(400);
  });

  it('refuses an adjustment posted to a different bank account, and posts nothing', async () => {
    const before = await countEntries();
    await expect(
      createAdjustmentEntry(company, reconId, otherBank, contra, 50, 'K020 wrong bank', user),
    ).rejects.toThrow(/does not match the reconciliation/);
    expect(await countEntries()).toBe(before);
    const row = await pool.query(
      'SELECT reconciled_balance FROM bank_reconciliations WHERE id=$1', [reconId]);
    expect(Number(row.rows[0].reconciled_balance)).toBe(400);
  });

  it('refuses an adjustment on a completed reconciliation and preserves its balances', async () => {
    await pool.query(
      "UPDATE bank_reconciliations SET status='completed' WHERE id=$1", [reconId]);
    const before = await countEntries();
    await expect(
      createAdjustmentEntry(company, reconId, bank, contra, 50, 'K020 after sign-off', user),
    ).rejects.toThrow(/completed reconciliation/);
    expect(await countEntries()).toBe(before);
    const row = await pool.query(
      'SELECT gl_balance, reconciled_balance FROM bank_reconciliations WHERE id=$1', [reconId]);
    expect(Number(row.rows[0].gl_balance)).toBe(400);
    expect(Number(row.rows[0].reconciled_balance)).toBe(400);
  });
});
