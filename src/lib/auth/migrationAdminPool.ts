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
 *     or reads the columns a charge is made with (`migrationAdminSqlTx`).
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
    // S-07e adds billing: each metered PAYG request's debit (and refund), Flow
    // purchases, mandates, the two billing crons, and a Paystack webhook that
    // writes billing rows (it holds one connection for its event). Each is a
    // short transaction and none is held across an outside call, hence 8 by
    // default; MIGRATION_ADMIN_POOL_MAX overrides it.
    max: poolSizeFromEnv('MIGRATION_ADMIN_POOL_MAX', 8),
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
export async function migrationAdminTx<T>(label: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  // Inside a transaction that already holds a migration_admin client (the
  // Paystack webhook's, publicRouteTx.ts): run in a savepoint on it, so this
  // commits or rolls back with the event. Sequence such calls: savepoints on
  // one connection nest LIFO, as with withTransaction.
  const store = als.getStore();
  if (store?.migrationAdminOnDemand && !store.migrationAdminClient && !store.finished) {
    const opened = await migrationAdminPool().connect();
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
  const joined = store?.migrationAdminClient;
  if (joined) {
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
  const claims = als.getStore()?.claims;
  const client = await migrationAdminPool().connect();
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
 * `migrationAdminTx` with a tagged-template `tx` shaped like `withTransaction`'s
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
  });
}
