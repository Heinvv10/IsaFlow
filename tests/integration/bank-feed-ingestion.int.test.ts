// tests/integration/bank-feed-ingestion.int.test.ts
/**
 * Canonical feed ingestion against real Postgres: idempotent redelivery,
 * pending lifecycle, protected conflicts, content-hash identity, tenancy,
 * the connection lease, and "sync never posts".
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
const otherCompany = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const otherBank = crypto.randomUUID();
const expense = crypto.randomUUID();
const provConn = crypto.randomUUID();
const extConn = crypto.randomUUID();

beforeAll(async () => {
  for (const [id, name] of [[company, 'BFI co'], [otherCompany, 'BFI other']]) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const [id, co] of [[bank, company], [otherBank, otherCompany]]) {
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype,is_active)
       VALUES($1,$2,'1110','BFI Bank','asset','debit','bank',true)`, [id, co]);
  }
  // An expense contra and an open period, so an auto-create rule WOULD post if
  // ingestion ever ran one: without them the "never posts" test cannot fail.
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active)
     VALUES($1,$2,'6100','BFI Expense','expense','debit',true)`, [expense, company]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'BFI 2026',1,2026,'2026-01-01','2026-12-31','open')`, [company]);
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active,config)
     VALUES($1,$2,$3,'test_provider','active',true,'{}'),($4,$2,$3,'extension','active',true,'{"bankId":"absa"}')`,
    [provConn, company, bank, extConn]);
});

afterAll(async () => {
  try {
    for (const co of [company, otherCompany]) {
      await pool.query('DELETE FROM bank_feed_transaction_conflicts WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM bank_import_batches WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM bank_feed_sync_logs WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [co]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM companies WHERE id=$1', [co]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

beforeEach(async () => {
  await pool.query('DELETE FROM bank_feed_transaction_conflicts WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
});

async function inRequest<T>(fn: () => Promise<T>, co = company): Promise<T> {
  const { als } = await import('@/lib/als');
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: user, companyId: co, claims: {} }, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    // Mirrors the route: a refusal is a 4xx, which withAuth / withExtensionToken COMMIT.
    if (isBankIngestionRefusal(e)) { await client.query('COMMIT'); throw e; }
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

const ptx = (id: string, o: Partial<NormalizedBankTransaction> = {}): NormalizedBankTransaction => ({
  identity: { kind: 'provider', providerTransactionId: id }, state: 'posted',
  transactionDate: '2026-09-05', amount: -120, currency: 'ZAR', description: 'BFI SHOP',
  providerUpdatedAt: '2026-09-05T10:00:00Z', ...o,
});
const batchOf = (connectionId: string, txs: NormalizedBankTransaction[]): BankIngestionBatch => ({
  source: { kind: 'feed', connectionId }, fetchedAt: '2026-09-11T08:00:00Z', transactions: txs,
});

async function ingest(connectionId: string, txs: NormalizedBankTransaction[], co = company) {
  const { ingestBankBatch } = await import('@/modules/accounting/services/bank/feed/bankIngestionService');
  return inRequest(() => ingestBankBatch(co, batchOf(connectionId, txs), { userId: user, sourceLabel: 'test', bankFormat: null }), co);
}

describe('canonical feed ingestion', () => {
  it('redelivering the same provider transaction never creates a second row', async () => {
    const first = await ingest(provConn, [ptx('a1')]);
    const again = await ingest(provConn, [ptx('a1')]);
    expect(first.counts.inserted).toBe(1);
    expect(again.counts).toMatchObject({ inserted: 0, duplicate: 1 });
    const { rows } = await pool.query('SELECT count(*)::int n FROM bank_transactions WHERE company_id=$1', [company]);
    expect(rows[0].n).toBe(1);
  });

  it('concurrent delivery of one transaction yields one row', async () => {
    const results = await Promise.allSettled([ingest(provConn, [ptx('c1')]), ingest(provConn, [ptx('c1')])]);
    const { rows } = await pool.query("SELECT count(*)::int n FROM bank_transactions WHERE provider_transaction_id='c1'");
    expect(rows[0].n).toBe(1);
    // The loser either waited and counted a duplicate, or was refused as SYNC_IN_PROGRESS.
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as { code?: string }).code).toBe('SYNC_IN_PROGRESS');
    }
  });

  it('refuses an inactive connection and writes nothing', async () => {
    await pool.query("UPDATE bank_feed_connections SET is_active=false WHERE id=$1", [provConn]);
    try {
      await expect(ingest(provConn, [ptx('inact1')])).rejects.toMatchObject({ code: 'CONNECTION_INACTIVE' });
      const { rows } = await pool.query("SELECT count(*)::int n FROM bank_transactions WHERE provider_transaction_id='inact1'");
      expect(rows[0].n).toBe(0);
    } finally {
      await pool.query("UPDATE bank_feed_connections SET is_active=true WHERE id=$1", [provConn]);
    }
  });

  it('refuses a connection whose bank account is not a valid active bank GL account', async () => {
    await pool.query("UPDATE gl_accounts SET is_active=false WHERE id=$1", [bank]);
    try {
      await expect(ingest(provConn, [ptx('badacct1')])).rejects.toMatchObject({ code: 'BANK_ACCOUNT_INVALID' });
      const { rows } = await pool.query("SELECT count(*)::int n FROM bank_transactions WHERE provider_transaction_id='badacct1'");
      expect(rows[0].n).toBe(0);
    } finally {
      await pool.query("UPDATE gl_accounts SET is_active=true WHERE id=$1", [bank]);
    }
  });

  it('a change to an unprocessed posted row refreshes in place', async () => {
    await ingest(provConn, [ptx('ref1')]);
    const r = await ingest(provConn, [ptx('ref1', { amount: -130, description: 'BFI SHOP 2', providerUpdatedAt: '2026-09-06T00:00:00Z' })]);
    expect(r.counts).toMatchObject({ updated: 1, conflicts: 0 });
    const { rows } = await pool.query("SELECT amount::float a, description FROM bank_transactions WHERE provider_transaction_id='ref1'");
    expect(rows[0]).toEqual({ a: -130, description: 'BFI SHOP 2' });
  });

  it('pending then posted updates in place and becomes reviewable', async () => {
    const p = await ingest(provConn, [ptx('p1', { state: 'pending', amount: -119 })]);
    expect(p.counts).toMatchObject({ inserted: 1, pending: 1 });
    await ingest(provConn, [ptx('p1', { amount: -120, providerUpdatedAt: '2026-09-06T00:00:00Z' })]);
    const { rows } = await pool.query("SELECT feed_state, amount::float a, status FROM bank_transactions WHERE provider_transaction_id='p1'");
    expect(rows[0]).toEqual({ feed_state: 'posted', a: -120, status: 'imported' });
  });

  it('a pending refresh without providerUpdatedAt keeps the stored timestamp', async () => {
    await ingest(provConn, [ptx('pu1', { state: 'pending', amount: -119, providerUpdatedAt: '2026-09-05T09:00:00Z' })]);
    await ingest(provConn, [ptx('pu1', { state: 'pending', amount: -121, providerUpdatedAt: undefined })]);
    const { rows } = await pool.query(
      "SELECT feed_state, amount::float a, provider_updated_at FROM bank_transactions WHERE provider_transaction_id='pu1'");
    expect(rows[0].feed_state).toBe('pending');
    expect(rows[0].a).toBe(-121);
    expect(rows[0].provider_updated_at.toISOString()).toBe('2026-09-05T09:00:00.000Z');
  });

  it('pending then removed keeps the audit row', async () => {
    await ingest(provConn, [ptx('r1', { state: 'pending' })]);
    const r = await ingest(provConn, [ptx('r1', { state: 'removed' })]);
    expect(r.counts.removed).toBe(1);
    const { rows } = await pool.query("SELECT feed_state FROM bank_transactions WHERE provider_transaction_id='r1'");
    expect(rows[0].feed_state).toBe('removed');
  });

  it('a provider change to a processed row becomes a conflict, never an overwrite', async () => {
    await ingest(provConn, [ptx('x1')]);
    await pool.query("UPDATE bank_transactions SET status='excluded' WHERE provider_transaction_id='x1'");
    const r = await ingest(provConn, [ptx('x1', { amount: -999, providerUpdatedAt: '2026-09-07T00:00:00Z' })]);
    expect(r.counts.conflicts).toBe(1);
    const { rows } = await pool.query("SELECT amount::float a FROM bank_transactions WHERE provider_transaction_id='x1'");
    expect(rows[0].a).toBe(-120);
    const c = await pool.query("SELECT reason, proposed->>'amount' amt FROM bank_feed_transaction_conflicts WHERE provider_transaction_id='x1' AND resolved_at IS NULL");
    expect(c.rows).toEqual([{ reason: 'processed_row_changed', amt: '-999' }]);
    // A second identical delivery refreshes the open conflict rather than adding one.
    await ingest(provConn, [ptx('x1', { amount: -999, providerUpdatedAt: '2026-09-08T00:00:00Z' })]);
    const c2 = await pool.query("SELECT count(*)::int n FROM bank_feed_transaction_conflicts WHERE provider_transaction_id='x1'");
    expect(c2.rows[0].n).toBe(1);
  });

  it('extension batches dedupe by content hash against existing rows but keep identical rows within a batch', async () => {
    const { contentHashIdentity } = await import('@/modules/accounting/services/bank/feed/bankIngestionValidation');
    const f = { transactionDate: '2026-09-05', amount: -50, description: 'ABSA FEE' };
    const t: NormalizedBankTransaction = { ...f, identity: contentHashIdentity(f), state: 'posted', currency: 'ZAR' };
    const first = await ingest(extConn, [t, t]);
    expect(first.counts.inserted).toBe(2);
    const again = await ingest(extConn, [t]);
    expect(again.counts).toMatchObject({ inserted: 0, duplicate: 1 });
    const { rows } = await pool.query('SELECT bank_feed_connection_id, provider_transaction_id FROM bank_transactions WHERE company_id=$1 LIMIT 1', [company]);
    expect(rows[0]).toEqual({ bank_feed_connection_id: extConn, provider_transaction_id: null });
  });

  it('refuses another company’s connection and writes nothing', async () => {
    await expect(ingest(provConn, [ptx('t1')], otherCompany)).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
    const { rows } = await pool.query("SELECT count(*)::int n FROM bank_transactions WHERE provider_transaction_id='t1'");
    expect(rows[0].n).toBe(0);
    // The lease is never acquired for a connection outside the caller's company, so no sync log is written either.
    const logs = await pool.query('SELECT count(*)::int n FROM bank_feed_sync_logs WHERE company_id=$1', [otherCompany]);
    expect(logs.rows[0].n).toBe(0);
  });

  it('never creates a journal and only runs suggestion rules', async () => {
    await pool.query(
      `INSERT INTO bank_categorisation_rules(company_id,rule_name,match_field,match_type,match_pattern,gl_account_id,is_active,auto_create_entry,priority)
       VALUES($1,'auto','description','contains','BFI SHOP',$3,true,true,1),
             ($1,'suggest','description','contains','BFI SHOP',$2,true,false,2)`, [company, bank, expense]);
    const before = await pool.query('SELECT count(*)::int n FROM gl_journal_entries WHERE company_id=$1', [company]);
    const r = await ingest(provConn, [ptx('j1')]);
    const after = await pool.query('SELECT count(*)::int n FROM gl_journal_entries WHERE company_id=$1', [company]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(r.appliedSuggestions).toBe(1);
    const { rows } = await pool.query("SELECT status, suggested_gl_account_id FROM bank_transactions WHERE provider_transaction_id='j1'");
    expect(rows[0]).toEqual({ status: 'imported', suggested_gl_account_id: bank });
    await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id=$1', [company]);
  });

  it('writes a success sync log with the counts, and a failed log on refusal', async () => {
    await ingest(provConn, [ptx('l1'), ptx('l2', { state: 'pending' })]);
    const ok = await pool.query(
      `SELECT status, transactions_found f, transactions_imported i, transactions_pending p
       FROM bank_feed_sync_logs WHERE connection_id=$1 ORDER BY started_at DESC LIMIT 1`, [provConn]);
    expect(ok.rows[0]).toEqual({ status: 'success', f: 2, i: 2, p: 1 });
    await expect(ingest(provConn, [ptx('bad', { transactionDate: '2026-02-30' })])).rejects.toMatchObject({ code: 'INVALID_TRANSACTION' });
    const bad = await pool.query(
      'SELECT status, error_code FROM bank_feed_sync_logs WHERE connection_id=$1 ORDER BY started_at DESC LIMIT 1', [provConn]);
    expect(bad.rows[0]).toEqual({ status: 'failed', error_code: 'INVALID_TRANSACTION' });
  });
});
