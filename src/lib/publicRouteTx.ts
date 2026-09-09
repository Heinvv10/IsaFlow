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
 *
 * NOT an RLS context. Unlike `withAuth`, this issues no `SET LOCAL ROLE
 * app_user` and no `request.jwt.claims`, because a public gateway callback has
 * no authenticated tenant to set them from: the writes run as the pool owner
 * with row-level security bypassed, exactly as they did on the pool before.
 * Tenant isolation on this path therefore rests entirely on the explicit
 * `company_id` predicates in the services called from `fn` — every query they
 * issue must carry one.
 */
import { getDbPool } from '@/lib/neon';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';

export async function withPublicRouteTransaction<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Nesting this inside a request transaction would als.run over the request's
  // own context — dropping its companyId and RLS GUCs — and COMMIT a transaction
  // the outer one knows nothing about. Both callers are public routes; refuse
  // rather than let a future authenticated caller find out in production.
  if (als.getStore()) {
    throw new Error(
      `withPublicRouteTransaction(${label}) called inside an existing request transaction`,
    );
  }
  const client = await getDbPool().connect();
  // Set ONLY when the ROLLBACK itself fails. A business-logic throw that rolls
  // back cleanly leaves a perfectly reusable connection; destroying it on every
  // failed webhook would churn the pool for nothing.
  let unusable: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId: '', claims: {} }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is in an unknown state. Keep the rollback failure so the
      // release below DESTROYS it rather than handing an aborted or still-open
      // transaction to the next unrelated request.
      unusable = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      log.warn('Public route ROLLBACK failed', { label }, 'PublicRouteTx');
    }
    throw err;
  } finally {
    client.release(unusable);
  }
}
