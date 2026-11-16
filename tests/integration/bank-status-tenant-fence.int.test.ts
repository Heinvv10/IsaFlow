// A bank_transactions row of ANOTHER company that points at this company's GL bank account (the FK targets
// gl_accounts(id) alone, and RLS does not hide it for the pool role) must not be counted in this company's status.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
const uuid = () => crypto.randomUUID();
const [coA, coB, bankA] = [uuid(), uuid(), uuid()];

async function line(co: string, amount: number) {
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
     VALUES($1,$2,$3,'2025-04-10',$4,'fence fixture','imported')`, [uuid(), co, bankA, amount]);
}

describeIfDb('bank account status — tenant fence on the bank_transactions lateral', () => {
  beforeAll(async () => {
    for (const [co, name] of [[coA, 'Fence A'], [coB, 'Fence B']]) {
      await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [co, name]);
    }
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$2,'FNB','Fence Bank','asset','bank','debit')`, [bankA, coA]);
    await line(coA, 100);
    await line(coB, 7000); // the foreign row, pointing at A's GL account
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM bank_transactions WHERE bank_account_id=$1', [bankA]);
      await pool.query('DELETE FROM gl_accounts WHERE id=$1', [bankA]);
      for (const co of [coA, coB]) await pool.query('DELETE FROM companies WHERE id=$1', [co]);
    } finally {
      await pool.end();
    }
  });

  it("does not count another company's line on this company's bank account", async () => {
    const [row] = await getBankAccountsStatus(coA);
    expect(row).toMatchObject({ id: bankA, txnCount: 1, balance: 100, unreconciledCount: 1, totalCredits: 100 });
  });

  it('the other company sees none of the account either', async () => {
    expect(await getBankAccountsStatus(coB)).toEqual([]);
  });
});
