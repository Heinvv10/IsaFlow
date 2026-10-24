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
 *   - the rest of that class (S-07d, migration 935): member role changes and
 *     removals, AFS portal magic links and contacts, the AR portal login,
 *     share links, auditor sessions, capture inboxes and WhatsApp claims, and
 *     bank feed connections.
 */
import pg from 'pg';
// Side-effect import: registers the DATE (OID 1082) parser for every pg Pool
// in this process. See src/lib/pgTypes.ts.
import '@/lib/pgTypes';
import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { als } from '@/lib/als';

let _pool: pg.Pool | null = null;

export function migrationAdminPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.MIGRATION_ADMIN_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_ADMIN_DATABASE_URL required: invitations, change-email, erasure, PATs, OAuth, password reset');
  _pool = new pg.Pool({
    connectionString: url,
    // change-email holds a connection (and its users row) across one GoTrue
    // call, bounded at AUTH_UPSTREAM_TIMEOUT_MS, so two slow ones no longer
    // starve invite accept, erasure and signup. A caller waiting longer than
    // the checkout bound for a connection gets an error instead of waiting
    // forever: the same bound rollbackFailed assumes for the other pools.
    // Nothing else holds a connection across an outside call: the OAuth token
    // endpoint checks a code or refresh token on the service pool before it
    // comes here, and an invitation calls GoTrue between its transactions.
    max: 4,
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
  const claims = als.getStore()?.claims;
  const client = await migrationAdminPool().connect();
  let opened = false;
  let unusable = false;
  try {
    opened = true; // before BEGIN (R-176): a BEGIN that reached the server but failed is rolled back too
    await client.query('BEGIN');
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
