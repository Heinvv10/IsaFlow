/**
 * Every write a delivery or a mirror scan makes to a company's route rows
 * (webhook_endpoints, imap_mirror_connections, sent_mirror_connections: S-07e
 * part B, migration 946), and the scan cron's due selection, on the
 * migration_admin login (BYPASSRLS, not the table owner). No app role may write
 * those tables at all: while their stamps (failure_count, scan_cursor,
 * last_scan_at, last_error, the counters) were app-writable, SQL injected on an
 * app pool forged them on any company's rows.
 *
 * A pool of its own, not migrationAdminPool() (sign-in, invitations and the
 * credential writes; max 4). The scan crons are serial and hold one connection
 * each, but deliveries run after commit, one fireWebhook per event and with no
 * bound on how many at once, and every delivery to one endpoint stamps the same
 * row: a burst queues on that row lock, holding a connection per waiter for up to
 * ROUTE_LOCK_WAIT. On the credential pool that queue would hold up sign-ins; here
 * it holds up only other stamps, which are bookkeeping. Default 3 (one per scan
 * cron, one for deliveries); ROUTE_ADMIN_POOL_MAX overrides it.
 *
 * Each call is one fixed, parameterised statement in a transaction of its own
 * that waits at most ROUTE_LOCK_WAIT for a row lock (55P03 past it: the caller
 * decides; a scan skips its connection for the tick, a delivery loses one stamp).
 * Only migration_admin sessions can hold a conflicting lock now: an app role has
 * no UPDATE, so it cannot SELECT ... FOR UPDATE these rows, and the key-share
 * lock its scan-log or delivery-log INSERT takes does not conflict with an
 * UPDATE of non-key columns. It never joins a request's transaction: a stamp
 * commits on its own. This role bypasses RLS, so every statement names its
 * row by id AND company_id.
 */
import pg from 'pg';
// Side-effect import: registers the DATE (OID 1082) parser for every pg Pool in this process.
import '@/lib/pgTypes';
import { log } from '@/lib/logger';
import { poolSizeFromEnv } from '@/lib/limits/poolLimits';
import { rollbackFailed } from '@/lib/rollbackFailed';

/** The longest a route-row write waits for a row another transaction holds. */
export const ROUTE_LOCK_WAIT = '2s';

let _pool: pg.Pool | null = null;

export function routeAdminPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.MIGRATION_ADMIN_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_ADMIN_DATABASE_URL required: webhook delivery and mirror scan stamps (S-07e part B)');
  _pool = new pg.Pool({
    connectionString: url,
    max: poolSizeFromEnv('ROUTE_ADMIN_POOL_MAX', 3),
    connectionTimeoutMillis: 15_000,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
  // pg-pool re-emits a pooled or removed client's 'error' on the pool; unlistened, that is an uncaught exception.
  _pool.on('error', (err) => log.warn('route admin pool error', { message: err.message }, 'Auth'));
  return _pool;
}

/** Runs `text` with `params` in a short transaction of its own on routeAdminPool(); returns its rows. */
export async function routeAdminQuery(label: string, text: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const client = await routeAdminPool().connect();
  let opened = false;
  let unusable = false;
  try {
    opened = true; // before BEGIN (R-176): a BEGIN that reached the server but failed is rolled back too
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${ROUTE_LOCK_WAIT}'`);
    const { rows } = await client.query(text, params);
    await client.query('COMMIT');
    opened = false;
    return rows as Record<string, unknown>[];
  } catch (err) {
    if (opened) unusable = await rollbackFailed(client, label);
    throw err;
  } finally {
    client.release(unusable);
  }
}
