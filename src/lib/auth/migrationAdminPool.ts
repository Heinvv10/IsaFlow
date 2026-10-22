/**
 * The memoised pool on MIGRATION_ADMIN_DATABASE_URL (BYPASSRLS, not the table
 * owner), for the two invite-accept routes. They write a membership for a
 * user who is not yet a member: no app_user or app_service policy and guard
 * admits that write, by design (S-07b, migration 911), so it runs on this
 * role from fixed, parameterised statements and never from the app pools.
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
  if (!url) throw new Error('MIGRATION_ADMIN_DATABASE_URL required for invite accept');
  _pool = new pg.Pool({
    connectionString: url,
    max: 2,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
  // pg-pool re-emits a pooled or removed client's 'error' on the pool; unlistened, that is an uncaught exception.
  _pool.on('error', (err) => log.warn('invite accept pool error', { message: err.message }, 'Auth'));
  return _pool;
}
