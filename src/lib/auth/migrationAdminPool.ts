/**
 * The memoised pool on MIGRATION_ADMIN_DATABASE_URL (BYPASSRLS, not the table
 * owner), for writes neither app pool may make, each from fixed,
 * parameterised statements:
 *   - the two invite-accept routes write a membership for a user who is not
 *     yet a member; no app_user or app_service policy and guard admits that
 *     write, by design (S-07b, migration 916);
 *   - change-email and the POPIA erasure write users.email, keyed on the
 *     verified session's user id, and emailVerificationService (register,
 *     resend, verify-email) owns the verification tokens whose payload becomes
 *     users.email: migration 918 takes both away from the service pool
 *     (S-07b follow-ups);
 *   - every credential and membership write (S-07c, migration 930): PAT and
 *     capture-key create and revoke, every OAuth write but the last-used
 *     stamp, invitation create, refresh and send status, password-reset
 *     tokens and the impersonation stash. Their rows are honoured as an
 *     identity, so no app role may write them;
 *   - the rest of that class (S-07d, migration 937): member role changes and
 *     removals, AFS portal magic links and contacts, the AR portal login,
 *     share links, auditor sessions, capture inboxes and WhatsApp claims, and
 *     bank feed connections;
 *   - billing (S-07e, migration 945): the Flows wallet, ledger and purchases,
 *     the subscription and charge crons, the Paystack webhook's settlement,
 *     and mandate create, verify and revoke. No app role writes those tables
 *     or reads the columns a charge is made with (`migrationAdminSqlTx`);
 *   - outbound-feed and mailbox connections (S-07e part B, migration 946):
 *     webhook_endpoints and imap_mirror_connections / sent_mirror_connections
 *     (every create, update, disconnect and delete, and what a delivery or a
 *     scan stamps on them): a forged claim could otherwise re-point an
 *     endpoint's url, or a mailbox's IMAP host, at an outside server. Those run
 *     on the same login in a pool of their own with a 2 s lock wait
 *     (routeAdminPool.ts), not here, so a blocked delete never holds a sign-in's
 *     connection.
 */
import pg from 'pg';
import { buildQuery, type TxSql } from '@/lib/neon';
// Side-effect import: registers the DATE (OID 1082) parser for every pg Pool
// in this process. See src/lib/pgTypes.ts.
import '@/lib/pgTypes';
import { log } from '@/lib/logger';
import { poolSizeFromEnv } from '@/lib/limits/poolLimits';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { als } from '@/lib/als';

let _pool: pg.Pool | null = null;

export function migrationAdminPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.MIGRATION_ADMIN_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_ADMIN_DATABASE_URL required: credential, membership and portal writes (S-07b/c/d)');
  _pool = new pg.Pool({
    connectionString: url,
    // change-email holds a connection (and its users row) across one GoTrue
    // call, bounded at AUTH_UPSTREAM_TIMEOUT_MS, so two slow ones no longer
    // starve invite accept, erasure and signup. A caller waiting longer than
    // the checkout bound for a connection gets an error instead of waiting
    // forever: the same bound rollbackFailed assumes for the other pools.
    // Nothing else holds a connection across an outside call: the OAuth token
    // endpoint checks a code or refresh token on the service pool before it
    // comes here, an invitation calls GoTrue between its transactions, and
    // the AR portal login runs bcrypt between its two. The unauthenticated
    // callers (S-07d) are bounded before they get here: AR portal login and
    // AFS sign-in requests and verifies are rate-limited per IP, and a WhatsApp
    // webhook is signature-checked and reads an active binding on the service
    // pool first. Every transaction waits at most 5 s for a lock (below).
    // Billing (S-07e) has a pool of its own on the same login (billingAdminPool
    // below), so metering cannot starve these. MIGRATION_ADMIN_POOL_MAX overrides it.
    max: poolSizeFromEnv('MIGRATION_ADMIN_POOL_MAX', 4),
    connectionTimeoutMillis: 15_000,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
  // pg-pool re-emits a pooled or removed client's 'error' on the pool; unlistened, that is an uncaught exception.
  _pool.on('error', (err) => log.warn('migration_admin pool error', { message: err.message }, 'Auth'));
  return _pool;
}

let _billingPool: pg.Pool | null = null;

/**
 * The same login (migration_admin), in a pool of its own for the billing writes
 * (S-07e, migration 945): every metered PAYG request's debit and refund, Flow
 * purchases, mandates, the billing crons and the Paystack webhook's settlement.
 * Kept apart so a burst of metered requests, or a webhook holding one
 * connection for its event, never queues a sign-in, an invitation or a
 * credential write behind it. Each billing transaction is short, waits at most
 * 5 s for a lock, and is never held across an outside call.
 * BILLING_ADMIN_POOL_MAX overrides the size.
 */
export function billingAdminPool(): pg.Pool {
  if (_billingPool) return _billingPool;
  const url = process.env.MIGRATION_ADMIN_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_ADMIN_DATABASE_URL required: billing writes (S-07e)');
  _billingPool = new pg.Pool({
    connectionString: url,
    max: poolSizeFromEnv('BILLING_ADMIN_POOL_MAX', 6),
    connectionTimeoutMillis: 15_000,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
  _billingPool.on('error', (err) => log.warn('billing admin pool error', { message: err.message }, 'Auth'));
  return _billingPool;
}

/** Savepoint names for migrationAdminTx calls joined to an outer migration_admin transaction. */
let joinedSeq = 0;

/**
 * Run `fn` in one transaction on a migrationAdminPool() client: BEGIN, COMMIT,
 * a ROLLBACK on any throw, and a connection whose ROLLBACK failed destroyed
 * rather than pooled (R-176). For the fixed, parameterised statements above,
 * keyed on ids the TypeScript layer verified, never on claims read in SQL.
 *
 * Inside a request, the request's verified claims are set on the transaction
 * for entity_change_capture alone, so the change log still names the actor and
 * the session (impersonation included). This role bypasses RLS and the member
 * guards, so nothing here is decided by them.
 */
export async function migrationAdminTx<T>(label: string, fn: (client: pg.PoolClient) => Promise<T>,
  pool: () => pg.Pool = migrationAdminPool): Promise<T> {
  // Inside a transaction that holds (or opens on demand) a migration_admin
  // client (the Paystack webhook's, publicRouteTx.ts): run in a savepoint on
  // it, so this commits or rolls back with the event. Such calls must be
  // sequenced, as with withTransaction; a concurrent one is refused.
  const store = als.getStore();
  const joining = Boolean(store?.migrationAdminClient || (store?.migrationAdminOnDemand && !store.finished));
  if (store && joining) {
    // Concurrent calls would both open a client (one leaked) or interleave savepoints.
    if (store.migrationAdminBusy) throw new Error(`migrationAdminTx(${label}): concurrent calls in one transaction must be sequenced`);
    store.migrationAdminBusy = true;
    try {
      return await joinedTx(store, label, fn);
    } finally {
      store.migrationAdminBusy = false;
    }
  }
  return ownTx(label, fn, pool);
}

/** Run `fn` in a savepoint on the context's migration_admin client, opening it (BEGIN) on the first call. */
async function joinedTx<T>(store: NonNullable<ReturnType<typeof als.getStore>>, label: string,
  fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!store.migrationAdminClient) {
    // Only billing joins (the Paystack webhook), so its pool.
    const opened = await billingAdminPool().connect();
    try {
      await opened.query('BEGIN');
      await opened.query(`SET LOCAL lock_timeout = '5s'`);
    } catch (err) {
      const openFailed = await rollbackFailed(opened, label);
      opened.release(openFailed);
      throw err;
    }
    store.migrationAdminClient = opened;
  }
  const joined = store.migrationAdminClient;
  joinedSeq = (joinedSeq + 1) % 1_000_000;
  const sp = `migration_admin_${joinedSeq}`;
  await joined.query(`SAVEPOINT ${sp}`);
  try {
    const result = await fn(joined);
    await joined.query(`RELEASE SAVEPOINT ${sp}`);
    return result;
  } catch (err) {
    // A failed ROLLBACK TO leaves the outer transaction aborted; it rolls back as a whole.
    await joined.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch((rbErr: unknown) => log.warn(`${label}: ROLLBACK TO SAVEPOINT failed`,
      { message: rbErr instanceof Error ? rbErr.message : String(rbErr) }, 'Auth'));
    throw err;
  }
}

/** One transaction of its own on a migrationAdminPool() client (the usual case). */
async function ownTx<T>(label: string, fn: (client: pg.PoolClient) => Promise<T>, pool: () => pg.Pool): Promise<T> {
  const claims = als.getStore()?.claims;
  const client = await pool().connect();
  let opened = false;
  let unusable = false;
  try {
    opened = true; // before BEGIN (R-176): a BEGIN that reached the server but failed is rolled back too
    await client.query('BEGIN');
    // Bounded: a lock an app-pool request holds (a share link's view counter,
    // an ingest's lease) must not keep one of this pool's connections.
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    if (claims && Object.keys(claims).length > 0) {
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    }
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

/**
 * Billing's `migrationAdminTx`, on billingAdminPool(), with a tagged-template `tx` shaped like `withTransaction`'s
 * (`TxSql`), so a statement written as ``tx`SELECT ... ${id}` `` moves here
 * unchanged. Every interpolation is a bound parameter. This role bypasses RLS:
 * each statement names the company it is for, from the verified request.
 */
export async function migrationAdminSqlTx<T>(label: string, fn: (tx: TxSql) => Promise<T>): Promise<T> {
  return migrationAdminTx(label, (client) => {
    const tx: TxSql = async (strings, ...values) => {
      const { text, values: params } = buildQuery(strings, values);
      return (await client.query(text, params)).rows as unknown[];
    };
    return fn(tx);
  }, billingAdminPool);
}
