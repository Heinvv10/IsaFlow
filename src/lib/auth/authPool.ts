// src/lib/auth/authPool.ts
//
// The pg Pool withAuth runs every request's transaction on. Its own pool,
// separate from src/lib/neon.ts, because withAuth needs a raw client it can
// BEGIN/COMMIT around and hand to the ALS scope.
import pg from 'pg';
// Side-effect import: registers the DATE (OID 1082) parser for every pg Pool
// in this process. This module builds its own Pool, so it must not depend on
// src/lib/neon.ts having been imported first. See src/lib/pgTypes.ts.
import '@/lib/pgTypes';
import { log } from '@/lib/logger';

// ── Coupled with src/lib/pdf/renderSemaphore.ts ──────────────────────────────
// A pack PDF render holds one of these connections for its whole duration AND
// the headless browser re-enters the API for the report, taking a second. The
// render semaphore therefore derives BOTH of its bounds from the two constants
// below rather than carrying its own copies:
//   - its queue wait must expire before a caller's connection acquire does,
//     or a request refused for capacity has already failed on the pool;
//   - its concurrency ceiling is a fraction of the pool size, so renders and
//     their inbound fetches cannot take every connection.
// Change either constant and the semaphore's bounds move with it. Do not
// restate these numbers anywhere else.
export const AUTH_POOL_CONNECTION_TIMEOUT_MS = 15_000;
export const DEFAULT_AUTH_POOL_MAX = 20;

/** The pool's configured size. Read per call, the same way the pool itself
 *  reads it, so the semaphore and the pool can never disagree. */
export function authPoolMax(): number {
  return Number(process.env.AUTH_POOL_MAX ?? DEFAULT_AUTH_POOL_MAX);
}

let _pool: pg.Pool | null = null;

export function getAuthPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  _pool = new pg.Pool({
    connectionString: url,
    max: authPoolMax(),
    connectionTimeoutMillis: AUTH_POOL_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 30000,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
  _pool.on('error', (err) => log.warn('withAuth pool background error', { message: err.message }, 'Auth'));
  return _pool;
}
