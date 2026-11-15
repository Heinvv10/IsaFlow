/**
 * WP1 PR-A: GET /api/accounting/bank-import-batches through the real route and Postgres.
 *   - Newest STATEMENT first: re-importing an older month later does not displace the latest statement.
 *   - The line count is live (bank_transactions naming the batch now), not what the import wrote.
 *   - Another company's batch never appears, even one filed against this company's bank account id
 *     (bank_import_batches.bank_account_id has no FK since 446: a filter, never a fence).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bankImportBatches from '../../pages/api/accounting/bank-import-batches';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { bankCompany, cleanupBankControlsA, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let f: BankCompany;
let other: BankCompany;

beforeAll(async () => {
  a = await createUser(pool, tokens);
  f = await bankCompany(pool, [[a, 'admin']], companies);
  other = await bankCompany(pool, [[a, 'admin']], companies);
});
afterAll(async () => { await cleanupBankControlsA(pool, companies, [a]); });

/** A batch of `lines` imported lines, its statement dated `statementDate`, created at `createdAt`. */
async function plant(company: string, bank: string, statementDate: string, createdAt: string, lines: number): Promise<string> {
  const id = (await pool.query(
    `INSERT INTO bank_import_batches(company_id, bank_account_id, statement_date, transaction_count, imported_by,
       import_channel, bank_format, closing_balance, balance_source, created_at)
     VALUES($1,$2,$3::DATE,$4,$5,'upload','fnb',100.00,'running_balance',$6::TIMESTAMPTZ) RETURNING id`,
    [company, bank, statementDate, lines, a, createdAt])).rows[0].id as string;
  for (let i = 0; i < lines; i++) {
    await pool.query(
      `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, import_batch_id)
       VALUES($1,$2,$3::DATE,$4,$5,'imported',$6)`, [company, bank, statementDate, -(i + 1), `RT ${id.slice(0, 8)} ${i}`, id]);
  }
  return id;
}

type Batch = { id: string; statementDate: string; transactionCount: number; transactionsRemaining: number;
  balanceSource: string | null; importChannel: string | null; sourceLabel: string };
const list = async (bankAccountId: string, company = f.c) => {
  const res = await callRoute(bankImportBatches as never, tokens[a]!, company, 'GET', undefined,
    `/api/accounting/bank-import-batches?bankAccountId=${bankAccountId}`, { bankAccountId });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return (res.state.body as { data: { batches: Batch[] } }).data.batches;
};

describe('GET /api/accounting/bank-import-batches', () => {
  let september = '';
  let august = '';

  it('orders by statement date: an older statement imported later does not come first', async () => {
    september = await plant(f.c, f.bank, '2026-09-30', '2026-10-01T08:00:00Z', 3);
    august = await plant(f.c, f.bank, '2026-08-31', '2026-10-02T08:00:00Z', 2); // re-imported a day later
    const batches = await list(f.bank);
    expect(batches.map((b) => b.id)).toEqual([september, august]);
    expect(batches[0]).toMatchObject({ statementDate: '2026-09-30', balanceSource: 'running_balance', importChannel: 'upload', sourceLabel: 'FNB' });
  });

  it('counts lines live: 2 of 3 deleted leaves 1, while transaction_count still says 3', async () => {
    await pool.query(
      `DELETE FROM bank_transactions WHERE id IN (
         SELECT id FROM bank_transactions WHERE company_id = $1 AND import_batch_id = $2 ORDER BY id LIMIT 2)`, [f.c, september]);
    const batch = (await list(f.bank)).find((b) => b.id === september)!;
    expect({ remaining: batch.transactionsRemaining, written: batch.transactionCount }).toEqual({ remaining: 1, written: 3 });
  });

  it('never returns another company\'s batch, even one filed against this bank account id', async () => {
    const foreign = await plant(other.c, f.bank, '2026-12-31', '2026-12-31T08:00:00Z', 1);
    const mine = await list(f.bank);
    expect(mine.map((b) => b.id)).toEqual([september, august]);
    expect((await list(f.bank, other.c)).map((b) => b.id)).toEqual([foreign]);
  });

  it('a bankAccountId that is not a UUID is a 400', async () => {
    for (const bad of ['not-a-uuid', `${f.bank}' OR '1'='1`]) {
      const res = await callRoute(bankImportBatches as never, tokens[a]!, f.c, 'GET', undefined,
        '/api/accounting/bank-import-batches', { bankAccountId: bad });
      expect(res.state.statusCode, bad).toBe(400);
    }
  });

  it('a failed read is a 500, not an empty list', async () => {
    // A real DB error on this disposable fixture: the column the read selects is briefly missing.
    await pool.query('ALTER TABLE bank_import_batches RENAME COLUMN balance_source TO balance_source_gone');
    try {
      const res = await callRoute(bankImportBatches as never, tokens[a]!, f.c, 'GET', undefined,
        '/api/accounting/bank-import-batches', { bankAccountId: f.bank });
      expect(res.state.statusCode).toBe(500);
      expect(JSON.stringify(res.state.body)).not.toContain('"batches"');
    } finally {
      await pool.query('ALTER TABLE bank_import_batches RENAME COLUMN balance_source_gone TO balance_source');
    }
  });
});
