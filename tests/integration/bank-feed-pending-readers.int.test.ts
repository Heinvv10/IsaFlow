import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const conn = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'BFPR company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype,is_active)
     VALUES($1,$2,'1110','BFPR Bank','asset','debit','bank',true)`, [bank, company]);
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active)
     VALUES($1,$2,$3,'test_provider','active',true)`, [conn, company, bank]);
  const ins = (amount: number, state: string, pid: string | null) => pool.query(
    `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,
       bank_feed_connection_id,provider_transaction_id,feed_state)
     VALUES($1,$2,'2026-09-03',$3,'BFPR',$4,$5,$6)`,
    [company, bank, amount, pid ? conn : null, pid, state]);
  await ins(-100, 'posted', null);
  await ins(-30, 'pending', 'bfpr-pending');
  await ins(-7, 'removed', 'bfpr-removed');
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  const { als } = await import('@/lib/als');
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    return await als.run({ client, userId: user, companyId: company, claims: {} }, fn);
  } finally { await client.query('ROLLBACK'); client.release(); }
}

describe('readers', () => {
  it('cash statement balance counts only posted rows', async () => {
    const { getBankAccountsStatus } = await import('@/modules/accounting/services/bank/bankAccountStatusService');
    const accounts = await inRequest(() => getBankAccountsStatus(company));
    const acct = (accounts as Array<{ id?: string; accountId?: string; balance?: number; txnCount?: number }>)
      .find((a) => (a.id ?? a.accountId) === bank);
    expect(acct?.balance).toBe(-100);
  });

  it('review queue shows pending, hides removed, and exposes feedState', async () => {
    const { getBankTransactions } = await import('@/modules/accounting/services/bank/bankTransactionQueryService');
    const page = await inRequest(() => getBankTransactions(company, { bankAccountId: bank, status: 'imported' }));
    const states = page.transactions.map((t) => t.feedState).sort();
    expect(states).toEqual(['pending', 'posted']);
    expect(page.total).toBe(2);
  });
});
