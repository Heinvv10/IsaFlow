// A reconciliation session claims ALLOCATED lines and counts each one matched to
// its own allocation journal line; completion reconciles them.
//
// Production (Velocity Fibre): every bank line allocated through the feed, the
// ledger equal to the statement to the cent — and start claimed only
// `imported` lines, so SBSA (all 575 allocated) claimed 0, matched 0 and could
// never complete, and the dashboard showed 13,920 "unreconciled".
//
// Fixture, statement 2025-04-24, statement balance 400:
//   T0  2025-04-01 +100  reconciled on an EARLIER completed session  → not re-claimed
//   T1  2025-04-10 +500  allocated, JE1 posted                        → self-matched
//   T2  2025-04-20 -200  allocated, JE2 posted                        → self-matched
//   T3  2025-05-05  +70  allocated, JE3 after the statement date      → not claimed
//   T4  2025-04-15   -9  excluded                                     → not claimed
//   T5  2025-04-12  +50  allocated, JE5 REVERSED (contra JE5R)        → not self-matched
//   TB  company B, allocated on its own bank account                  → untouched
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  startReconciliation, completeReconciliation,
} from '@/modules/accounting/services/bank/bankReconciliationService';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
const uuid = () => crypto.randomUUID();
const [company, other, user] = [uuid(), uuid(), uuid()];
const [bank, contra, bankB, contraB] = [uuid(), uuid(), uuid(), uuid()];
const [apr, may, aprB] = [uuid(), uuid(), uuid()];
const tx = { T0: uuid(), T1: uuid(), T2: uuid(), T3: uuid(), T4: uuid(), T5: uuid(), TB: uuid() };
const earlier = uuid();

/** A posted two-line journal: bank DR/CR `amount`, contra the other side. Returns the bank line id. */
async function journal(co: string, period: string, bankId: string, contraId: string,
  date: string, amount: number, extra: { reversedAt?: boolean; reversalOf?: string; id?: string } = {}) {
  const je = extra.id ?? uuid();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by,fiscal_period_id,
       posted_at,posted_by,reversed_at,reversal_of_id)
     VALUES($1,$2,$3::DATE,'self-match fixture','posted',$4,$5,NOW(),$4,$6,$7)`,
    [je, co, date, user, period, extra.reversedAt ? new Date() : null, extra.reversalOf ?? null]);
  const line = uuid();
  const dr = amount > 0 ? amount : 0;
  const cr = amount < 0 ? -amount : 0;
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$2,$3,$4,$5,$6),($7,$2,$3,$8,$6,$5)`,
    [line, co, je, bankId, dr, cr, uuid(), contraId]);
  return { je, line };
}

async function bankTx(id: string, co: string, bankId: string, date: string, amount: number,
  status: string, line: string | null, recon: string | null = null) {
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,
       status,matched_journal_line_id,reconciliation_id)
     VALUES($1,$2,$3,$4::DATE,$5,'self-match fixture',$6,$7,$8)`,
    [id, co, bankId, date, amount, status, line, recon]);
}

const state = async (id: string) => (await pool.query(
  'SELECT status, reconciliation_id FROM bank_transactions WHERE id=$1', [id])).rows[0];

describeIfDb('bank reconciliation — allocated lines are their own match', () => {
  let recId = '';

  beforeAll(async () => {
    for (const [co, name] of [[company, 'Self-match A'], [other, 'Self-match B']]) {
      await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [co, name]);
    }
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    // One period number per company and year (uq_fiscal_periods_company_year_period): May is period 2.
    for (const [id, co, name, n, s, e] of [
      [apr, company, 'SM Apr', 1, '2025-04-01', '2025-04-30'], [may, company, 'SM May', 2, '2025-05-01', '2025-05-31'],
      [aprB, other, 'SM Apr B', 1, '2025-04-01', '2025-04-30']]) {
      await pool.query(
        `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
         VALUES($1,$2,$3,$4,2025,$5::DATE,$6::DATE,'open')`, [id, co, name, n, s, e]);
    }
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$5,'SMB','SM Bank','asset','bank','debit'),($2,$5,'SMC','SM Contra','revenue',NULL,'credit'),
             ($3,$6,'SMB','SM Bank B','asset','bank','debit'),($4,$6,'SMC','SM Contra B','revenue',NULL,'credit')`,
      [bank, contra, bankB, contraB, company, other]);

    const j0 = await journal(company, apr, bank, contra, '2025-04-01', 100);
    await pool.query(
      `INSERT INTO bank_reconciliations(id,company_id,bank_account_id,statement_date,statement_balance,
         gl_balance,reconciled_balance,status,started_by,completed_by,completed_at)
       VALUES($1,$2,$3,'2025-04-05',100,100,100,'completed',$4,$4,NOW())`, [earlier, company, bank, user]);
    await bankTx(tx.T0, company, bank, '2025-04-01', 100, 'reconciled', j0.line, earlier);
    await bankTx(tx.T1, company, bank, '2025-04-10', 500, 'allocated',
      (await journal(company, apr, bank, contra, '2025-04-10', 500)).line);
    await bankTx(tx.T2, company, bank, '2025-04-20', -200, 'allocated',
      (await journal(company, apr, bank, contra, '2025-04-20', -200)).line);
    await bankTx(tx.T3, company, bank, '2025-05-05', 70, 'allocated',
      (await journal(company, may, bank, contra, '2025-05-05', 70)).line);
    await bankTx(tx.T4, company, bank, '2025-04-15', -9, 'excluded', null);
    const j5 = await journal(company, apr, bank, contra, '2025-04-12', 50, { reversedAt: true });
    await journal(company, apr, bank, contra, '2025-04-12', -50, { reversalOf: j5.je });
    await bankTx(tx.T5, company, bank, '2025-04-12', 50, 'allocated', j5.line);
    await bankTx(tx.TB, other, bankB, '2025-04-10', 500, 'allocated',
      (await journal(other, aprB, bankB, contraB, '2025-04-10', 500)).line);
  });

  afterAll(async () => {
    try {
      for (const co of [company, other]) {
        await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [co]);
        await pool.query('DELETE FROM bank_reconciliations WHERE company_id=$1', [co]);
        await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [co]);
        await pool.query('UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id=$1', [co]);
        await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [co]);
      }
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [[bank, contra, bankB, contraB]]);
      for (const co of [company, other]) {
        await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [co]);
        await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [co]);
        await pool.query('DELETE FROM companies WHERE id=$1', [co]);
      }
      await pool.query('DELETE FROM users WHERE id=$1', [user]);
    } finally {
      await pool.end();
    }
  });

  it('start self-matches exactly the valid allocated lines on or before the statement date', async () => {
    const r = await startReconciliation(company, bank, '2025-04-24', 400, user);
    recId = r.id;
    expect(r.glBalance).toBe(400);
    expect(r.difference).toBe(0);
    expect(r).toMatchObject({ selfMatched: 2, claimedUnallocated: 0, matchedCount: 2 });
    expect((await state(tx.T1)).reconciliation_id).toBe(recId);
    expect((await state(tx.T2)).reconciliation_id).toBe(recId);
    expect(await state(tx.T0)).toEqual({ status: 'reconciled', reconciliation_id: earlier });
    expect((await state(tx.T3)).reconciliation_id).toBeNull();
    expect(await state(tx.T4)).toEqual({ status: 'excluded', reconciliation_id: null });
    expect((await state(tx.T5)).reconciliation_id).toBeNull();
    expect(await state(tx.TB)).toEqual({ status: 'allocated', reconciliation_id: null });
  });

  it('completion at R0.00 reconciles the self-matched lines and nothing else', async () => {
    const done = await completeReconciliation(company, recId, user);
    expect(done.status).toBe('completed');
    expect(await state(tx.T1)).toEqual({ status: 'reconciled', reconciliation_id: recId });
    expect(await state(tx.T2)).toEqual({ status: 'reconciled', reconciliation_id: recId });
    expect((await state(tx.T3)).status).toBe('allocated');
    expect((await state(tx.T5)).status).toBe('allocated');
    expect((await state(tx.TB)).status).toBe('allocated');
  });

  it('a later session does not re-claim lines a completed session reconciled', async () => {
    const r = await startReconciliation(company, bank, '2025-04-30', 400, user);
    expect(r).toMatchObject({ selfMatched: 0, claimedUnallocated: 0 });
    expect((await state(tx.T1)).reconciliation_id).toBe(recId);
  });
});
