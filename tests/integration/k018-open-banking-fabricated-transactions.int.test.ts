/**
 * K-018 — RED. `syncBankFeed` refuses only `manual_csv` and `extension`
 * (openBankingSyncService.ts:161 and :173 on ebeac9ca). Every other provider —
 * `basiq`, `tink`, `plaid`, all three accepted by the create-connection Zod
 * enum at pages/api/accounting/bank-feeds/index.ts:21 and by
 * `createBankFeedConnection`'s own allowlist — falls through to
 * `buildSampleTransactions` (line 22): 5 to 10 rows of `Math.random()` amounts
 * with descriptions off a hardcoded list, INSERTed into the tenant's real
 * `bank_transactions` as `status = 'imported'` (line 71).
 *
 * The run then reports success: `markSyncComplete` writes
 * `last_sync_status = 'success'` and a transactions_imported count, and the
 * route returns 200. Nothing in the response or the row says the data is fake.
 *
 * Those rows are the input to reconciliation, the bank-rule sweep and the
 * allocation screen — invented cash that a user can post to the GL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import {
  syncBankFeed,
  createBankFeedConnection,
  BankFeedProviderNotImplementedError,
} from '@/modules/accounting/services/bank/openBankingService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K018-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let bankAccount: string;
const connections: Record<string, string> = {};

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const c: PoolClient = await pool.connect();
  await c.query('BEGIN');
  try {
    const out = await als.run(
      { client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn,
    );
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Mirrors pages/api/accounting/bank-feeds/[id]/sync.ts inside `withAuth`: the
 * route catches BankFeedProviderNotImplementedError and answers 400, and
 * withAuth COMMITs on any status below 500. Returns the status the route would
 * have sent, so a regression back to an uncaught throw (500) ROLLBACKs here too.
 */
async function throughRoute(connectionId: string): Promise<number> {
  const c: PoolClient = await pool.connect();
  await c.query('BEGIN');
  let status = 200;
  try {
    await als.run(
      { client: c, userId: USER, companyId: COMPANY, claims: {} } as never,
      () => syncBankFeed(COMPANY, connectionId, USER),
    );
  } catch (err) {
    status = err instanceof BankFeedProviderNotImplementedError ? 400 : 500;
  }
  await c.query(status >= 500 ? 'ROLLBACK' : 'COMMIT');
  c.release();
  return status;
}

describeIfDb('K-018 unsupported open-banking providers fabricate transactions', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${COMPANY}::UUID, ${'K018 ' + TAG}, ${TAG}, NOW())`;
    bankAccount = ((await sql`
      INSERT INTO gl_accounts
        (company_id, account_code, account_name, account_type, account_subtype,
         normal_balance, is_active, is_system_account)
      VALUES (${COMPANY}::UUID, '1000', 'K018 Bank', 'asset', 'bank', 'debit', true, true)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${OTHER_COMPANY}::UUID, ${'K018 other ' + TAG}, ${TAG + '-o'}, NOW())`;
    for (const provider of ['basiq', 'tink', 'plaid']) {
      connections[provider] = ((await sql`
        INSERT INTO bank_feed_connections (company_id, bank_account_id, provider, is_active)
        VALUES (${COMPANY}::UUID, ${bankAccount}::UUID, ${provider}, true)
        RETURNING id`) as { id: string }[])[0]!.id;
    }
  });

  afterAll(async () => {
    await sql`DELETE FROM bank_feed_sync_logs WHERE company_id = ${OTHER_COMPANY}::UUID`;
    await sql`DELETE FROM bank_feed_connections WHERE company_id = ${OTHER_COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${OTHER_COMPANY}::UUID`;
    await sql`DELETE FROM bank_feed_sync_logs WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM bank_feed_connections WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM bank_transactions WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (
      SELECT id FROM gl_accounts WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await pool.end();
  }, 60000);

  it.each(['basiq', 'tink', 'plaid'])(
    'writes no transactions for the unimplemented provider %s',
    async (provider) => {
      let refused = false;
      try {
        const result = await inTx(() => syncBankFeed(COMPANY, connections[provider]!, USER));
        // If it does not refuse, it must at least not have invented anything.
        expect(result.imported).toBe(0);
      } catch {
        refused = true;
      }

      const rows = (await sql`
        SELECT description, amount::float8 AS amount FROM bank_transactions
        WHERE company_id = ${COMPANY}::UUID
          AND bank_reference LIKE ${provider + '-stub-%'}`) as
        { description: string; amount: number }[];

      // THE CLAIM: nothing invented reached the tenant's bank feed.
      expect(rows).toEqual([]);
      expect(refused || rows.length === 0).toBe(true);
    },
    60000,
  );

  // ── Adjacent cases ──────────────────────────────────────────────────────────

  it('answers 400, not 500, so the refusal survives the transaction', async () => {
    expect(await throughRoute(connections.basiq!)).toBe(400);

    // Read on a different connection, after COMMIT — this is durable state.
    const [conn] = (await sql`
      SELECT last_sync_status, last_sync_error FROM bank_feed_connections
      WHERE id = ${connections.basiq!}::UUID AND company_id = ${COMPANY}::UUID`) as
      { last_sync_status: string; last_sync_error: string }[];
    expect(conn!.last_sync_status).toBe('failed');
    expect(conn!.last_sync_error).toMatch(/not implemented/);

    const [logRow] = (await sql`
      SELECT status, transactions_imported FROM bank_feed_sync_logs
      WHERE connection_id = ${connections.basiq!}::UUID
        AND company_id = ${COMPANY}::UUID
      ORDER BY started_at DESC LIMIT 1`) as
      { status: string; transactions_imported: number }[];
    expect(logRow!.status).toBe('failed');
    expect(Number(logRow!.transactions_imported ?? 0)).toBe(0);
  }, 60000);

  it('carries the reason in the error the route puts in the 400 envelope', async () => {
    await expect(inTx(() => syncBankFeed(COMPANY, connections.plaid!, USER)))
      .rejects.toThrow(BankFeedProviderNotImplementedError);
    await expect(inTx(() => syncBankFeed(COMPANY, connections.plaid!, USER)))
      .rejects.toThrow(/plaid.*not implemented.*no transactions were imported/s);
  }, 60000);

  it('retrying the refused sync still imports nothing', async () => {
    for (let i = 0; i < 3; i++) {
      expect(await throughRoute(connections.tink!)).toBe(400);
    }
    const [row] = (await sql`
      SELECT count(*)::int AS n FROM bank_transactions
      WHERE company_id = ${COMPANY}::UUID`) as { n: number }[];
    expect(row!.n).toBe(0);
  }, 60000);

  it('refuses a wrong-tenant sync before it touches the connection', async () => {
    await expect(inTx(() => syncBankFeed(OTHER_COMPANY, connections.plaid!, USER)))
      .rejects.toThrow('Connection not found or does not belong to this company');

    const [row] = (await sql`
      SELECT count(*)::int AS n FROM bank_transactions
      WHERE company_id = ${OTHER_COMPANY}::UUID`) as { n: number }[];
    expect(row!.n).toBe(0);
  }, 60000);

  it.each(['basiq', 'tink', 'plaid'])(
    'refuses to create a %s connection at all',
    async (provider) => {
      await expect(inTx(() => createBankFeedConnection(
        COMPANY, { provider: provider as 'manual_csv', accountId: bankAccount }, USER,
      ))).rejects.toThrow(/Invalid provider/);

      const [row] = (await sql`
        SELECT count(*)::int AS n FROM bank_feed_connections
        WHERE company_id = ${COMPANY}::UUID AND provider = ${provider}`) as { n: number }[];
      // Only the one seeded by beforeAll — the create attempt added none.
      expect(row!.n).toBe(1);
    },
    60000,
  );

  it.each(['manual_csv', 'extension'])(
    'still returns instructions and imports nothing for the implemented provider %s',
    async (provider) => {
      const id = ((await sql`
        INSERT INTO bank_feed_connections (company_id, bank_account_id, provider, is_active)
        VALUES (${COMPANY}::UUID, ${bankAccount}::UUID, ${provider}, true)
        RETURNING id`) as { id: string }[])[0]!.id;

      const result = await inTx(() => syncBankFeed(COMPANY, id, USER));
      expect(result.imported).toBe(0);
      expect(result.instructions).toBeTruthy();

      const [row] = (await sql`
        SELECT count(*)::int AS n FROM bank_transactions
        WHERE company_id = ${COMPANY}::UUID`) as { n: number }[];
      expect(row!.n).toBe(0);
    },
    60000,
  );
});
