/**
 * Run `fn` the way `withAuth` runs a handler: one pooled client, one BEGIN, and
 * the ALS request context bound to it.
 *
 * `generateJournalFromRecurring` refuses to run outside a request transaction —
 * outside one its claim and its posting land on different connections, so a
 * posting failure would roll the claim back and leave an orphan journal
 * committed in the GL. A direct-call test therefore has to supply the same
 * context the route does.
 */
import type { Pool } from 'pg';
import { als } from '@/lib/als';

type Ctx = Parameters<typeof als.run>[0];

export async function inRequestTx<T>(
  pool: Pool,
  companyId: string,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await als.run({ client, userId, companyId, claims: {} } as unknown as Ctx, fn);
  } finally {
    // COMMIT even when `fn` threw, because that is what `withAuth` does for
    // every response below 500 — and K-049 is precisely a refusal that left a
    // write behind. Rolling back here would erase the write the assertions
    // after this call exist to look for. On an aborted transaction Postgres
    // executes the COMMIT as a rollback, which is the same thing the request
    // path would do.
    // Swallowed so a COMMIT failure cannot replace the error `fn` threw, which
    // is the one the test is asserting on.
    await client.query('COMMIT').catch(() => undefined);
    client.release();
  }
}
