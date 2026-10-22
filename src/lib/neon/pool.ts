/**
 * The process-wide pg pool: built once, lazily, on the first query.
 *
 * Part of `@/lib/neon` (R-184 split the former 475-line src/lib/neon.ts). Import
 * it ONLY from the barrel src/lib/neon.ts and its sibling modules: every other
 * file imports '@/lib/neon', which is what `vi.mock('@/lib/neon', ...)`
 * intercepts (guarded by tests/unit/lib/neonModuleShape.test.ts).
 */

import pg from 'pg';
import { log } from '@/lib/logger';
import { poolSizeFromEnv, MIN_PG_POOL_MAX } from '@/lib/limits/poolLimits';

// Imported for its side effect: registers the DATE (OID 1082) type parser so
// date columns arrive as 'YYYY-MM-DD' strings instead of local-midnight Dates.
// See src/lib/pgTypes.ts for why that matters.
import '@/lib/pgTypes';
import { serviceDatabaseUrl } from '@/lib/serviceDatabaseUrl';

let _pool: pg.Pool | null = null;

/**
 * The process-wide pool.
 *
 * Exported for the one caller that must open its OWN transaction and bind it
 * into ALS: a service reachable both inside a request (where withAuth already
 * holds a transaction) and from a script or cron (where every statement would
 * otherwise autocommit on its own). See `@/lib/alsTransaction`.
 */
export function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString: serviceDatabaseUrl(),
      max: poolSizeFromEnv('PG_POOL_MAX', 10, 'pool', MIN_PG_POOL_MAX),
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000,
      // Supabase self-hosted uses self-signed certs; flip DATABASE_SSL=strict
      // to enforce CA verification when moving to a properly-certified host.
      ssl:
        process.env.DATABASE_SSL === 'strict'
          ? { rejectUnauthorized: true }
          : process.env.DATABASE_SSL === 'disable'
            ? false
            : { rejectUnauthorized: false },
    });
    _pool.on('error', (err) => {
      log.warn('pg pool background error', { message: err.message }, 'DB');
    });
  }
  return _pool;
}

/** Test-only: hand the raw pool to integration tests that need a bound client. */
export function getPoolForTests(): pg.Pool {
  return getPool();
}

/**
 * The process-wide pool, for the few handlers that must open their own
 * BEGIN/COMMIT and bind it into ALS themselves (routes outside withAuth, e.g.
 * the Paystack webhook, which has no user or company to authenticate).
 */
export function getDbPool(): pg.Pool {
  return getPool();
}
