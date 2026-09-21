/**
 * K-071 — the best-effort work after a bank import runs without a savepoint.
 *
 * importParsedTransactions (bankImportService.ts:237-251) wraps the auto-post
 * sweep in a try/catch and logs the failure as "non-fatal". The two transfer
 * link passes above it were given savepoints (bankTransferLinkPasses.ts:69,
 * merged as K-019); this block was not.
 *
 * Inside a request there is no separate connection to fail on: withAuth has a
 * transaction open on the ALS-bound client, and withTransaction at :173 runs
 * the batch and its rows in a SAVEPOINT on that same client. A SQL error in
 * the swallowed block therefore aborts the REQUEST transaction. The catch
 * hides it, the function returns a batchId and an empty error list, and the
 * COMMIT that follows is answered by Postgres with a ROLLBACK — the import the
 * caller was told succeeded is gone.
 *
 * The sweep is mocked to fail the way any statement in that block can fail: it
 * runs one failing query on the request client and reports the error upward.
 * What is under test is bankImportService's missing savepoint, not the sweep.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

vi.mock('@/modules/accounting/services/bank/autoPostGateService', () => ({
  sweep: async () => {
    const { sql } = await import('@/lib/neon');
    await sql`SELECT 1 / 0`;
    return { runId: null, posted: 0, skipped: [] };
  },
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bankAccount = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K071 company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype)
     VALUES($1,$2,'1110','K071 Bank','asset','debit','bank')`,
    [bankAccount, company],
  );
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_import_batches WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('keeps the imported statement when the post-import sweep fails', async () => {
  const { als } = await import('@/lib/als');
  const { importParsedTransactions } = await import(
    '../../src/modules/accounting/services/bank/bankImportService'
  );

  const client = await pool.connect();
  let result: Awaited<ReturnType<typeof importParsedTransactions>> | null = null;
  let commitError: string | null = null;
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: user, companyId: company, claims: {} }, async () => {
      result = await importParsedTransactions(
        company,
        {
          transactions: [{
            transactionDate: '2026-03-01',
            valueDate: null,
            amount: -250.5,
            description: 'K071 outflow',
            reference: 'K071-REF',
          }],
          errors: [],
          bankFormat: 'generic',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        bankAccount,
        '2026-03-31',
        { importedBy: user },
      );
    });
    try {
      await client.query('COMMIT');
    } catch (err) {
      commitError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    client.release();
  }

  // The caller was told the import succeeded.
  expect(result).not.toBeNull();
  expect(result!.transactionCount).toBe(1);
  expect(commitError).toBeNull();

  // So the rows must be there after the request transaction commits.
  const batches = await pool.query(
    'SELECT id FROM bank_import_batches WHERE company_id=$1', [company],
  );
  expect(batches.rowCount).toBe(1);

  const txs = await pool.query(
    'SELECT id FROM bank_transactions WHERE company_id=$1', [company],
  );
  expect(txs.rowCount).toBe(1);
});
