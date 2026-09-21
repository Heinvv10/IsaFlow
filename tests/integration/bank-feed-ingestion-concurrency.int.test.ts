// tests/integration/bank-feed-ingestion-concurrency.int.test.ts
/**
 * Extension (content-hash) concurrency: the lease is what prevents a double
 * insert here — there is no unique index for content-hash identity, unlike
 * provider identity. Split out of bank-feed-ingestion.int.test.ts to keep
 * both files under the 300-line cap and to isolate the mutation check.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { isBankIngestionRefusal, type BankIngestionBatch, type NormalizedBankTransaction } from '@/modules/accounting/services/bank/feed/bankIngestionTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const extConn = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'BFIC co']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype,is_active)
     VALUES($1,$2,'1110','BFIC Bank','asset','debit','bank',true)`, [bank, company]);
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active,config)
     VALUES($1,$2,$3,'extension','active',true,'{"bankId":"absa"}')`, [extConn, company, bank]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_import_batches WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_feed_sync_logs WHERE company_id=$1', [company]);
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
    const out = await als.run({ client, userId: user, companyId: company, claims: {} }, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    if (isBankIngestionRefusal(e)) { await client.query('COMMIT'); throw e; }
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

async function ingest(txs: NormalizedBankTransaction[]) {
  const { ingestBankBatch } = await import('@/modules/accounting/services/bank/feed/bankIngestionService');
  const batch: BankIngestionBatch = { source: { kind: 'feed', connectionId: extConn }, fetchedAt: '2026-09-11T08:00:00Z', transactions: txs };
  return inRequest(() => ingestBankBatch(company, batch, { userId: user, sourceLabel: 'test', bankFormat: null }));
}

describe('canonical feed ingestion: extension content-hash concurrency', () => {
  it('two concurrent identical extension batches yield exactly one insert set', async () => {
    const { contentHashIdentity } = await import('@/modules/accounting/services/bank/feed/bankIngestionValidation');
    const f = { transactionDate: '2026-09-05', amount: -50, description: 'ABSA CONC FEE' };
    const t: NormalizedBankTransaction = { ...f, identity: contentHashIdentity(f), state: 'posted', currency: 'ZAR' };
    const results = await Promise.allSettled([ingest([t]), ingest([t])]);
    const { rows } = await pool.query(
      "SELECT count(*)::int n FROM bank_transactions WHERE company_id=$1 AND description='ABSA CONC FEE'", [company]);
    expect(rows[0].n).toBe(1);
    // The lease serialises content-hash batches (no unique index backs this identity): the loser
    // either saw the winner's hash and counted a duplicate, or was refused SYNC_IN_PROGRESS.
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as { code?: string }).code).toBe('SYNC_IN_PROGRESS');
    }
  });
});
