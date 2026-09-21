// tests/integration/bank-feed-ingestion-hardening.int.test.ts
/**
 * Final-review fixes to canonical feed ingestion, against real Postgres:
 * no empty import batch (F-I1), per-account serialisation across connections
 * (A-I2), the daily cap decided under the lease (A-6), reconciliation_id counts
 * as processed (A-9), and provider_updated_at never moving backwards (A-10).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  isBankIngestionRefusal, type BankIngestionBatch, type NormalizedBankTransaction,
} from '@/modules/accounting/services/bank/feed/bankIngestionTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const provConn = crypto.randomUUID();
const extA = crypto.randomUUID();
const extB = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'BFH co']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype,is_active)
     VALUES($1,$2,'1110','BFH Bank','asset','debit','bank',true)`, [bank, company]);
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active,config)
     VALUES($1,$2,$3,'test_provider','active',true,'{}'),
           ($4,$2,$3,'extension','active',true,'{"bankId":"absa"}'),
           ($5,$2,$3,'extension','active',true,'{"bankId":"absa"}')`,
    [provConn, company, bank, extA, extB]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_feed_transaction_conflicts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_reconciliations WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_import_batches WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_feed_sync_logs WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

beforeEach(async () => {
  await pool.query('DELETE FROM bank_feed_transaction_conflicts WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM bank_import_batches WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM bank_feed_sync_logs WHERE company_id=$1', [company]);
  await pool.query('UPDATE bank_feed_connections SET daily_tx_cap=NULL WHERE company_id=$1', [company]);
});

type Opts = { dailyCap?: number };
async function ingestOn(client: PoolClient, connectionId: string, txs: NormalizedBankTransaction[], opts: Opts = {}) {
  const { als } = await import('@/lib/als');
  const { ingestBankBatch } = await import('@/modules/accounting/services/bank/feed/bankIngestionService');
  const batch: BankIngestionBatch = { source: { kind: 'feed', connectionId }, fetchedAt: '2026-09-11T08:00:00Z', transactions: txs };
  return als.run({ client, userId: user, companyId: company, claims: {} },
    () => ingestBankBatch(company, batch, { userId: user, sourceLabel: 'test', bankFormat: null, ...opts }));
}

async function ingest(connectionId: string, txs: NormalizedBankTransaction[], opts: Opts = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await ingestOn(client, connectionId, txs, opts);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    // Mirrors the route: a refusal is a 4xx, which the request wrapper COMMITs.
    await client.query(isBankIngestionRefusal(e) ? 'COMMIT' : 'ROLLBACK'); throw e;
  } finally { client.release(); }
}

const ptx = (id: string, o: Partial<NormalizedBankTransaction> = {}): NormalizedBankTransaction => ({
  identity: { kind: 'provider', providerTransactionId: id }, state: 'posted',
  transactionDate: '2026-09-05', amount: -120, currency: 'ZAR', description: 'BFH SHOP',
  providerUpdatedAt: '2026-09-05T10:00:00Z', ...o,
});
async function etx(description: string, amount = -50): Promise<NormalizedBankTransaction> {
  const { contentHashIdentity } = await import('@/modules/accounting/services/bank/feed/bankIngestionValidation');
  const f = { transactionDate: '2026-09-05', amount, description };
  return { ...f, identity: contentHashIdentity(f), state: 'posted', currency: 'ZAR' };
}
const count = async (q: string) => (await pool.query(q, [company])).rows[0].n as number;

describe('canonical feed ingestion — final-review hardening', () => {
  it('a redelivery of known rows creates no import batch; a mixed batch counts only its inserts (F-I1)', async () => {
    const first = await ingest(provConn, [ptx('b1')]);
    const again = await ingest(provConn, [ptx('b1')]);
    expect(again.importBatchId).toBeNull();
    const mixed = await ingest(provConn, [ptx('b1'), ptx('b2')]);
    const { rows } = await pool.query(
      'SELECT id, transaction_count FROM bank_import_batches WHERE company_id=$1 ORDER BY created_at', [company]);
    expect(rows).toEqual([
      { id: first.importBatchId, transaction_count: 1 },
      { id: mixed.importBatchId, transaction_count: 1 },
    ]);
    const ext = await etx('BFH EXT FEE');
    await ingest(extA, [ext]);
    const extAgain = await ingest(extA, [ext]);
    expect(extAgain.importBatchId).toBeNull();
    expect(await count('SELECT count(*)::int n FROM bank_import_batches WHERE company_id=$1')).toBe(3);
  });

  it('two extension connections on one bank account serialise: one row per hash (A-I2)', async () => {
    const t = await etx('BFH TWO CONN FEE');
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await ingestOn(a, extA, [t]);
      // B leases a DIFFERENT connection, so only the per-account lock can make it wait for A.
      const pendingB = ingestOn(b, extB, [t]);
      await new Promise((r) => setTimeout(r, 400));
      await a.query('COMMIT');
      const rb = await pendingB;
      await b.query('COMMIT');
      expect(rb.counts).toMatchObject({ inserted: 0, duplicate: 1 });
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release(); b.release();
    }
    expect(await count("SELECT count(*)::int n FROM bank_transactions WHERE company_id=$1 AND description='BFH TWO CONN FEE'")).toBe(1);
  });

  it('refuses a batch over the daily cap under the lease, before any write (A-6)', async () => {
    await ingest(extA, [await etx('BFH CAP 1'), await etx('BFH CAP 2')], { dailyCap: 3 });
    await expect(ingest(extA, [await etx('BFH CAP 3'), await etx('BFH CAP 4')], { dailyCap: 3 }))
      .rejects.toMatchObject({ code: 'DAILY_CAP_EXCEEDED', message: 'Daily transaction cap of 3 would be exceeded.' });
    expect(await count("SELECT count(*)::int n FROM bank_transactions WHERE company_id=$1 AND description LIKE 'BFH CAP%'")).toBe(2);
    const { rows } = await pool.query(
      'SELECT status, error_code FROM bank_feed_sync_logs WHERE connection_id=$1 ORDER BY started_at DESC LIMIT 1', [extA]);
    expect(rows[0]).toEqual({ status: 'failed', error_code: 'DAILY_CAP_EXCEEDED' });
    // The connection's own daily_tx_cap overrides the caller's default.
    await pool.query('UPDATE bank_feed_connections SET daily_tx_cap=10 WHERE id=$1', [extA]);
    const ok = await ingest(extA, [await etx('BFH CAP 3'), await etx('BFH CAP 4')], { dailyCap: 3 });
    expect(ok.counts.inserted).toBe(2);
  });

  it('a provider change to a row carrying reconciliation_id is a conflict, never an overwrite (A-9)', async () => {
    await ingest(provConn, [ptx('rec1')]);
    const { rows: rec } = await pool.query(
      `INSERT INTO bank_reconciliations(bank_account_id,statement_date,started_by,company_id)
       VALUES($1,'2026-09-30',$2,$3) RETURNING id`, [bank, user, company]);
    await pool.query("UPDATE bank_transactions SET reconciliation_id=$1 WHERE provider_transaction_id='rec1' AND company_id=$2",
      [rec[0].id, company]);
    const r = await ingest(provConn, [ptx('rec1', { amount: -999, providerUpdatedAt: '2026-09-07T00:00:00Z' })]);
    expect(r.counts).toMatchObject({ conflicts: 1, updated: 0 });
    const { rows } = await pool.query(
      "SELECT amount::float a, status FROM bank_transactions WHERE provider_transaction_id='rec1' AND company_id=$1", [company]);
    expect(rows[0]).toEqual({ a: -120, status: 'imported' });
  });

  it('posting a pending row with an older providerUpdatedAt keeps the newer stored timestamp (A-10)', async () => {
    await ingest(provConn, [ptx('ts1', { state: 'pending', providerUpdatedAt: '2026-09-05T10:00:00Z' })]);
    await ingest(provConn, [ptx('ts1', { providerUpdatedAt: '2026-09-05T09:00:00Z' })]);
    const { rows } = await pool.query(
      "SELECT feed_state, provider_updated_at FROM bank_transactions WHERE provider_transaction_id='ts1' AND company_id=$1", [company]);
    expect(rows[0].feed_state).toBe('posted');
    expect(rows[0].provider_updated_at.toISOString()).toBe('2026-09-05T10:00:00.000Z');
  });
});
