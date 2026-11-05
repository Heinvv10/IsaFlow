// The bank grid highlights the paperclip of a line that has attachments, so every row the list returns carries its
// own attachment count (TX_SELECT). Proven against real Postgres, through getBankTransactions' account+status branch
// (the New / Reviewed tabs) and its account-only branch:
//   T1  2 attachments  → 2
//   T2  none           → 0
//   TB  company B's line with 1 attachment → never in company A's page, and does not leak into T1/T2's counts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
const uuid = () => crypto.randomUUID();
const [company, other, bank, bankB] = [uuid(), uuid(), uuid(), uuid()];
const [t1, t2, tb] = [uuid(), uuid(), uuid()];

async function attach(txId: string, name: string) {
  await pool.query(
    `INSERT INTO bank_transaction_attachments(bank_transaction_id, file_url, file_name, file_size)
     VALUES($1, 'data:image/png;base64,iVBORw0KGgo=', $2, 8)`, [txId, name]);
}

describeIfDb('bank transaction list — attachment count per row', () => {
  beforeAll(async () => {
    for (const [co, name] of [[company, 'Attach count A'], [other, 'Attach count B']]) {
      await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [co, name]);
    }
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$3,'ACB','AC Bank','asset','bank','debit'),($2,$4,'ACB','AC Bank B','asset','bank','debit')`,
      [bank, bankB, company, other]);
    for (const [id, co, acct, amount] of [[t1, company, bank, -100], [t2, company, bank, -50], [tb, other, bankB, -10]] as const) {
      await pool.query(
        `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
         VALUES($1,$2,$3,'2026-06-01',$4,'attach count fixture','imported')`, [id, co, acct, amount]);
    }
    await attach(t1, 'slip-1.png');
    await attach(t1, 'slip-2.png');
    await attach(tb, 'other.png');
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM bank_transaction_attachments WHERE bank_transaction_id = ANY($1::uuid[])', [[t1, t2, tb]]);
      for (const co of [company, other]) {
        await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [co]);
        await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [co]);
        await pool.query('DELETE FROM companies WHERE id=$1', [co]);
      }
    } finally {
      await pool.end();
    }
  });

  const counts = (txs: { id: string; attachmentCount?: number }[]) =>
    Object.fromEntries(txs.map(t => [t.id, t.attachmentCount]));

  it('returns each row its own count on the New tab (account + status)', async () => {
    const page = await getBankTransactions(company, { bankAccountId: bank, status: 'imported' });
    expect(counts(page.transactions)).toEqual({ [t1]: 2, [t2]: 0 });
  });

  it('returns the same counts on the account-only branch, and never the other company\'s line', async () => {
    const page = await getBankTransactions(company, { bankAccountId: bank });
    expect(counts(page.transactions)).toEqual({ [t1]: 2, [t2]: 0 });
  });
});
