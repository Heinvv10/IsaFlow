/**
 * One BEGIN/COMMIT for a route that has no withAuth wrapper.
 *
 * The Paystack webhook and the portal return-page verify endpoint are public:
 * there is no user or company to authenticate, so neither goes through
 * `withAuth`, and without this every `sql` call they make auto-commits on its
 * own pool connection. That is what let a half-applied payment survive a
 * throw (K-035) and what would let a GL posting failure leave an invoice
 * marked paid (K-036).
 *
 * The client is bound into ALS, so the plain `sql` tagged template inside every
 * service these routes call joins the same transaction — the same mechanism
 * `withAuth` uses. Respond only AFTER this resolves; a 200 sent from inside
 * `fn` would be a promise the COMMIT has not yet kept.
 */
import { getDbPool } from '@/lib/neon';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';

export async function withPublicRouteTransaction<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId: '', claims: {} }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      log.warn('Public route ROLLBACK failed', { label }, 'PublicRouteTx');
    }
    throw err;
  } finally {
    client.release();
  }
}
