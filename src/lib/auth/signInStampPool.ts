/**
 * The pool the sign-in stamp (recordSignIn.ts) runs on: the migration_admin login, in a pool of its own.
 *
 * Not migrationAdminPool(): the stamp is fire-and-forget and runs just after the response, so on the shared pool it
 * took the connection the route had only just released (invitation accept's own transaction connection), and a
 * burst of sign-ins would queue ahead of invitations and credential writes (max 4). Same pattern as
 * billingAdminPool and routeAdminPool. Two connections, and an exhausted pool fails the stamp after 2 s (logged
 * and swallowed by recordSignInSafely) instead of queueing behind other sign-ins.
 * SIGN_IN_STAMP_POOL_MAX overrides the size.
 */
import pg from 'pg';
// Side-effect import: registers the DATE (OID 1082) parser for every pg Pool in this process. See src/lib/pgTypes.ts.
import '@/lib/pgTypes';
import { log } from '@/lib/logger';
import { poolSizeFromEnv } from '@/lib/limits/poolLimits';

let _pool: pg.Pool | null = null;

export function signInStampPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.MIGRATION_ADMIN_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_ADMIN_DATABASE_URL required: the sign-in stamp (audit 2026-11-14, item 1.1)');
  _pool = new pg.Pool({
    connectionString: url,
    max: poolSizeFromEnv('SIGN_IN_STAMP_POOL_MAX', 2),
    connectionTimeoutMillis: 2_000,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
  // pg-pool re-emits a pooled or removed client's 'error' on the pool; unlistened, that is an uncaught exception.
  _pool.on('error', (err) => log.warn('sign-in stamp pool error', { message: err.message }, 'Auth'));
  return _pool;
}
