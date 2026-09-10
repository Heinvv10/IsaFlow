/**
 * K-081 review round 5 — L3. The round-4 change moved the close's serialisation
 * lock from `hashtext(company)::bigint` to `hashtextextended(company, 621)`,
 * because `hashtext` is int4 and would share one 2^32 key space with every
 * other `hashtext` advisory lock in the codebase (shareLinkService, mcp/audit).
 * A collision there does not corrupt anything — it makes a loan close block on
 * an unrelated share-link or audit operation, and vice versa.
 *
 * The ordering suite proves the close WAITS for a peer holding
 * `hashtextextended(company, 621)`. It cannot prove the key space is disjoint:
 * its holder hard-codes the same expression, so reverting the production line
 * makes it red only because the two sides stopped agreeing. This asserts the
 * property itself, by outcome — a foreign `hashtext` lock on the very same
 * company must NOT hold the close up.
 */
import { afterAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { assertClosesInOrder } from '@/modules/accounting/services/loans/loanPostingGuards';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

afterAll(async () => { await pool.end(); });

it('does not queue behind an unrelated hashtext advisory lock on the same company', async () => {
  const company = randomUUID();
  const user = randomUUID();

  // A share-link or mcp/audit operation for this company, mid-transaction.
  const foreign: PoolClient = await pool.connect();
  await foreign.query('BEGIN');
  await foreign.query('SELECT pg_advisory_xact_lock(hashtext($1::text)::bigint)', [company]);

  const closer: PoolClient = await pool.connect();
  await closer.query('BEGIN');
  try {
    // 5s is well past the ~10ms this takes unblocked, and well short of the
    // suite timeout, so a shared key space shows up as a timeout rather than
    // as a hang. `statement_timeout` is per statement, which is exactly the
    // pg_advisory_xact_lock wait we are bounding.
    await closer.query("SET LOCAL statement_timeout = '5s'");
    await expect(als.run(
      { client: closer, userId: user, companyId: company, claims: {} } as never,
      () => assertClosesInOrder(company, '202603'),
    )).resolves.toBeUndefined();
  } finally {
    await closer.query('ROLLBACK');
    closer.release();
    await foreign.query('ROLLBACK');
    foreign.release();
  }
}, 20_000);
