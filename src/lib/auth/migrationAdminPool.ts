/**
 * The memoised pool on MIGRATION_ADMIN_DATABASE_URL (BYPASSRLS, not the table
 * owner), for writes neither app pool may make, each from fixed,
 * parameterised statements keyed on the verified session's user id:
 *   - the two invite-accept routes write a membership for a user who is not
 *     yet a member; no app_user or app_service policy and guard admits that
 *     write, by design (S-07b, migration 916);
 *   - change-email and the POPIA erasure write users.email, which migration
 *     918 takes away from the service pool (S-07b follow-up A).
 */
import pg from 'pg';
// Side-effect import: registers the DATE (OID 1082) parser for every pg Pool
// in this process. See src/lib/pgTypes.ts.
import '@/lib/pgTypes';
import { log } from '@/lib/logger';

let _pool: pg.Pool | null = null;

export function migrationAdminPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.MIGRATION_ADMIN_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_ADMIN_DATABASE_URL required for invite accept, change-email and erasure');
  _pool = new pg.Pool({
    connectionString: url,
    max: 2,
    // change-email holds a connection (and its users row) across one GoTrue
    // call, bounded at AUTH_UPSTREAM_TIMEOUT_MS; a caller waiting longer than
    // this for a connection gets an error instead of waiting forever. The
    // same checkout bound rollbackFailed assumes for the other pools.
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
