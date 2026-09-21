// tests/integration/bank-feed-statement-dedup.int.test.ts
/**
 * A-16 — statement-import dedup ignores feed rows the bank REMOVED. A removed
 * row is an audit record of something that never posted; letting it occupy
 * its content hash would drop the real statement line as a "duplicate".
 * A posted row still dedupes. Proven on the agent import (dry run) and the
 * bulk-preview route, against real Postgres.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: (_r: unknown, data: unknown) => ({ kind: 'success', data }),
    badRequest: (_r: unknown, m: string) => ({ kind: 'badRequest', m }),
    validationError: (_r: unknown, e: unknown) => ({ kind: 'validation', e }),
  },
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const conn = crypto.randomUUID();

const CSV = [
  'Date,Description,Amount,Balance',
  '20220201,MONTHLY ACC FEE,-85,32186.5',
  '20220202,EFT REC SOMEONE,1200.00,33386.50',
].join('\n');

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'BFSD co']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype,is_active)
     VALUES($1,$2,'1110','BFSD Bank','asset','debit','bank',true)`, [bank, company]);
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active,config)
     VALUES($1,$2,$3,'test_provider','active',true,'{}')`, [conn, company, bank]);
  // The fee was pending at the bank and then REMOVED; the EFT is a real posted line.
  await pool.query(
    `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,
       bank_feed_connection_id,provider_transaction_id,feed_state)
     VALUES($1,$2,'2022-02-01',-85,'MONTHLY ACC FEE',$3,'bfsd-fee','removed'),
           ($1,$2,'2022-02-02',1200,'EFT REC SOMEONE',NULL,NULL,'posted')`, [company, bank, conn]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_import_batches WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  } finally { await pool.end(); }
});

async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  const { als } = await import('@/lib/als');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await als.run({ client, userId: user, companyId: company, claims: {} }, fn);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('statement dedup ignores removed feed rows (A-16)', () => {
  it('agent import: the removed fee is importable, the posted EFT is a duplicate', async () => {
    const { importStatementForAgent } = await import('@/modules/accounting/services/bank/bankStatementImportService');
    const r = await inRequest(() => importStatementForAgent({
      companyId: company, bankAccountId: bank, fileType: 'csv', content: CSV,
      statementDate: '2022-02-28', dryRun: true, importedBy: user,
    }));
    expect({ imported: r.imported, duplicates: r.duplicates }).toEqual({ imported: 1, duplicates: 1 });
  });

  it('bulk preview: only the posted EFT counts as a duplicate', async () => {
    const { default: handler } = await import('../../pages/api/accounting/bank-transactions-bulk-preview');
    const out = await inRequest(() => handler({
      method: 'POST', companyId: company, user: { id: user },
      body: { bankAccountId: bank, fileType: 'csv', filename: 'feb.csv', csvContent: CSV },
    } as never, {} as never)) as unknown as { kind: string; data: { duplicatesVsDb: number; totalParsed: number } };
    expect(out.kind).toBe('success');
    expect(out.data).toMatchObject({ totalParsed: 2, duplicatesVsDb: 1 });
  });

  it('runDedupPass (bankStatementDedupHelpers): the removed fee is not a duplicate, the posted EFT is', async () => {
    const { runDedupPass } = await import('@/modules/accounting/services/bank/bankStatementDedupHelpers');
    const results = await inRequest(() => runDedupPass(company, bank, [
      { date: '2022-02-01', amount: -85, description: 'MONTHLY ACC FEE' } as never,
      { date: '2022-02-02', amount: 1200, description: 'EFT REC SOMEONE' } as never,
    ]));
    expect(results.map((r) => r.isDuplicate)).toEqual([false, true]);
  });
});
