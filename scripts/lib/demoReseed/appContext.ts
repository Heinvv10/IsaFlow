/**
 * Runs app services on the reseed's own transaction. The app's `sql` joins the
 * client bound in AsyncLocalStorage (src/lib/neon/query.ts), so binding our
 * pg.Client there makes every statement a service issues part of the one
 * reseed transaction: it commits or rolls back with the rest.
 *
 * Used for the depreciation history, which the app's own depreciation service
 * posts month by month (so the seeded history is exactly what that service
 * would have produced), and by the integration test's service-level checks.
 */

import type { PoolClient } from 'pg';
import type pg from 'pg';
import { runOwnedContext } from '../../../src/lib/afterCommit';

export async function withAppContext<T>(
  client: pg.Client,
  actor: { userId: string; companyId: string },
  fn: () => Promise<T>,
): Promise<T> {
  // A pg.Client answers query() as a PoolClient does; release() is never called on it here.
  const poolClient = client as unknown as PoolClient;
  return runOwnedContext({ client: poolClient, userId: actor.userId, companyId: actor.companyId, claims: {}, afterCommit: [] }, fn);
}
