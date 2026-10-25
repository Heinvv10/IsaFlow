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
 * no authenticated tenant to set them from: the writes run as the service
 * pool's login (isaflow_service since S-07b, under app_service's policies,
 * which admit every tenant's rows; the table owner before it).
 * Tenant isolation on this path therefore rests entirely on the explicit
 * `company_id` predicates in the services called from `fn` — every query they
 * issue must carry one.
 */
import { getDbPool } from '@/lib/neon';
import { als, type RequestContext } from '@/lib/als';
import { runOwnedContext, drainAfterCommit } from '@/lib/afterCommit';
import { rollbackFailed } from '@/lib/rollbackFailed';

/**
 * `migrationAdmin`: a migration_admin transaction beside it, opened by the
 * first migrationAdminTx inside `fn` and joined by every later one (S-07e: the
 * billing tables are written only there; an event that writes none takes no
 * migration_admin connection). A throw rolls back both. On success migration_admin
 * COMMITs first: if the service pool's COMMIT then fails, the billing writes
 * stand without the event's `processed` stamp, the gateway redelivers, and
 * settlement, purchase completion, mandate activation, a charge's failure (it
 * counts an attempt only on a charge still in flight) and a mandate's revoke
 * are idempotent. The
 * other order could stamp an event processed whose billing writes were lost.
 */
export async function withPublicRouteTransaction<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { migrationAdmin?: boolean } = {},
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
  let unusable = false;
  let adminUnusable = false;
  const ctx: RequestContext = { client, userId: '', claims: {}, afterCommit: [],
    ...(opts.migrationAdmin ? { migrationAdminOnDemand: true } : {}) };
  try {
    await client.query('BEGIN');
    const result = await runOwnedContext(ctx, fn);
    // Opened by the first migrationAdminTx inside `fn`, if any (migrationAdminPool.ts).
    const admin = ctx.migrationAdminClient;
    if (admin) await admin.query('COMMIT');
    await client.query('COMMIT');
    drainAfterCommit(ctx);
    return result;
  } catch (err) {
    // The connection is in an unknown state when this fails. The release below then
    // DESTROYS it rather than handing an aborted or still-open transaction to the
    // next unrelated request.
    const admin = ctx.migrationAdminClient;
    if (admin) adminUnusable = await rollbackFailed(admin, `withPublicRouteTransaction(${label}) migration_admin`);
    unusable = await rollbackFailed(client, `withPublicRouteTransaction(${label})`);
    throw err;
  } finally {
    const admin = ctx.migrationAdminClient;
    if (admin) admin.release(adminUnusable);
    client.release(unusable);
  }
}
