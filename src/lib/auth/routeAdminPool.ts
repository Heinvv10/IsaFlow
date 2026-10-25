/**
 * Every write to a company's route rows (webhook_endpoints,
 * imap_mirror_connections, sent_mirror_connections: S-07e part B, migration 946)
 * and the scan cron's due selection, on the migration_admin login (BYPASSRLS, not
 * the table owner). No app role may write those tables at all: while their stamps
 * (failure_count, scan_cursor, last_scan_at, last_error, the counters) and the
 * columns a scan or a delivery acts on (url, events, imap_host, ...) were
 * app-writable, SQL injected on an app pool forged them on any company's rows.
 * That is the settings screens' create, update, disconnect and delete too
 * (mirrorConnectionService, sentMirrorAdmin, webhookEndpointWrites), and the
 * scans' and deliveries' stamps.
 *
 * A pool of its own, not migrationAdminPool() (sign-in, invitations and the
 * credential writes; max 4). The scan crons are serial and hold one connection
 * each, but deliveries run after commit, one fireWebhook per event and with no
 * bound on how many at once, and every delivery to one endpoint stamps the same
 * row: a burst queues on that row lock, holding a connection per waiter for up to
 * ROUTE_LOCK_WAIT. On the credential pool that queue would hold up sign-ins; here
 * it holds up only other route writes. Default 3 (one per scan cron, one for
 * deliveries); ROUTE_ADMIN_POOL_MAX overrides it.
 *
 * Each call is a short transaction of its own that waits at most ROUTE_LOCK_WAIT
 * for a row lock, and at most ROUTE_CONNECT_TIMEOUT_MS for a free connection (55P03
 * past either, the second as RouteAdminPoolTimeoutError: the caller decides; a scan
 * skips its connection for the tick, a delivery loses one stamp, a settings write
 * answers 503). The pool is shared by every tenant's route writes (max 3), so a write
 * that queues behind them fails in 2 s rather than holding its request open. Runs
 * at most ROUTE_STATEMENT_TIMEOUT per statement. routeAdminQuery is one fixed,
 * parameterised statement; routeAdminTx is for the few writes that must be atomic
 * across several (an endpoint update and its re-read). Only migration_admin
 * sessions can hold a conflicting lock now: an app role has no UPDATE, so it cannot
 * SELECT ... FOR UPDATE these rows, and the key-share lock its scan-log or
 * delivery-log INSERT takes blocks only a DELETE (bounded at ROUTE_LOCK_WAIT). It
 * never joins a request's transaction: a write commits on its own. This role
 * bypasses RLS, so every statement names its row by id AND company_id.
 */
import pg from 'pg';
// Side-effect import: registers the DATE (OID 1082) parser for every pg Pool in this process.
import '@/lib/pgTypes';
import { log } from '@/lib/logger';
import { poolSizeFromEnv } from '@/lib/limits/poolLimits';
import { rollbackFailed } from '@/lib/rollbackFailed';

/** The longest a route-row write waits for a row another transaction holds. */
export const ROUTE_LOCK_WAIT = '2s';

/** The longest one statement runs; these are single-row writes and a due selection of 20 rows. */
export const ROUTE_STATEMENT_TIMEOUT = '10s';

/**
 * The longest a write waits for one of the pool's few connections. A request holds its auth-pool connection and
 * transaction while it waits here, so the wait is the lock wait's size: a queued write answers 503 in 2 s instead of
 * stalling every tenant's requests behind it (a burst of DELETEs on a row a scan holds queued up to 22 s).
 */
export const ROUTE_CONNECT_TIMEOUT_MS = 2_000;

/**
 * The pool had no free connection within ROUTE_CONNECT_TIMEOUT_MS. It carries the lock timeout's SQLSTATE (55P03) on
 * purpose: everything that already handles "the row is held, try again" handles this the same way. A request answers
 * 503 (respondIfLockTimeout), a scan skips its connection for the tick (isScanLockSkip), and no caller reads it as the
 * scan or the delivery having failed (the connection is not flipped to 'error', no webhook failure is counted).
 */
const LOCK_NOT_AVAILABLE = '55P03';

export class RouteAdminPoolTimeoutError extends Error {
  readonly code = LOCK_NOT_AVAILABLE; // a SQLSTATE, not a refusal code for a caller to show (as ScanStampLockSkip's)
  constructor(label: string, cause: unknown) {
    super(`${label}: the route write pool is busy`, { cause });
    this.name = 'RouteAdminPoolTimeoutError';
  }
}

/** pg-pool's own messages for a connect that ran past connectionTimeoutMillis (waiting for a slot, or opening one). */
const isConnectTimeout = (err: unknown): boolean =>
  err instanceof Error && /timeout exceeded when trying to connect|connection timeout/i.test(err.message);

let _pool: pg.Pool | null = null;

export function routeAdminPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.MIGRATION_ADMIN_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_ADMIN_DATABASE_URL required: webhook delivery and mirror scan stamps (S-07e part B)');
  _pool = new pg.Pool({
    connectionString: url,
    max: poolSizeFromEnv('ROUTE_ADMIN_POOL_MAX', 3),
    connectionTimeoutMillis: ROUTE_CONNECT_TIMEOUT_MS,
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

/**
 * Runs `fn` in one transaction of its own on routeAdminPool(): BEGIN, the bounded lock wait and statement
 * time, COMMIT, a ROLLBACK on any throw, and a client whose ROLLBACK failed destroyed rather than pooled (R-176).
 */
export async function routeAdminTx<T>(label: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await routeAdminPool().connect();
  } catch (err) {
    throw isConnectTimeout(err) ? new RouteAdminPoolTimeoutError(label, err) : err;
  }
  let opened = false;
  let unusable = false;
  try {
    opened = true; // before BEGIN (R-176): a BEGIN that reached the server but failed is rolled back too
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${ROUTE_LOCK_WAIT}'`);
    await client.query(`SET LOCAL statement_timeout = '${ROUTE_STATEMENT_TIMEOUT}'`);
    const result = await fn(client);
    await client.query('COMMIT');
    opened = false;
    return result;
  } catch (err) {
    if (opened) unusable = await rollbackFailed(client, label);
    throw err;
  } finally {
    client.release(unusable);
  }
}

/** Runs `text` with `params` in a short transaction of its own on routeAdminPool(); returns its rows. */
export async function routeAdminQuery(label: string, text: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  return routeAdminTx(label, async (client) => (await client.query(text, params)).rows as Record<string, unknown>[]);
}
