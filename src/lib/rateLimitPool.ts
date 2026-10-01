/**
 * The rate limiter's own connection pool (K-103).
 *
 * The limiter must not write on the request's transaction: a request that rolls
 * back would never be charged, and the counter's row lock would be held until
 * the request ends. So its statements run here, outside any transaction, and
 * commit on their own.
 *
 * It is a SEPARATE pool on purpose. A request already holds one connection from
 * the main pool (`getPool` in `@/lib/neon`) for its transaction. If the limiter
 * took a second one from that same pool, as many concurrent requests as the
 * pool has connections would each wait for a connection none of them can free,
 * until the connect timeout.
 */

import pg from 'pg';
import { log } from '@/lib/logger';

/**
 * Connections per process. A key that is full is answered from memory (see
 * `checkRateLimit`), so the pool only carries calls that may be admitted.
 * Sized by measurement (R-175 fix.md, /review round): with 3, fifty concurrent
 * admitted calls waited up to 250 ms and a thousand on one key hit the connect
 * timeout; with 10, 97 ms and no timeout. Idle connections close after 30 s.
 */
export const RATE_LIMIT_POOL_MAX = 10;

/**
 * How long a limiter call waits for a connection before it throws. A throw is
 * what a database error has always been here: the caller's request fails, it is
 * never admitted unchecked.
 */
export const RATE_LIMIT_CONNECT_TIMEOUT_MS = 5000;

/**
 * Every wait on a limiter connection is bounded, and the server gives up first.
 * The counter rows can be locked by someone else (the nightly cleanup deletes
 * them through `sql`, possibly inside a transaction; DDL or VACUUM FULL holds
 * the table), and a stalled statement would otherwise pin one of only
 * RATE_LIMIT_POOL_MAX connections for as long as the lock lasts.
 *
 * Order matters: lock < statement < query. `query_timeout` is a client-side
 * timer that abandons the query without cancelling it, so if it fired first the
 * connection would go back to the pool with the statement still running.
 */
const LOCK_TIMEOUT_MS = 2000;
const STATEMENT_TIMEOUT_MS = 3000;
const QUERY_TIMEOUT_MS = 4000;

let _pool: pg.Pool | null = null;

export function getRateLimitPool(): pg.Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set. Please configure it in your environment.');
    }
    _pool = new pg.Pool({
      connectionString,
      max: RATE_LIMIT_POOL_MAX,
      connectionTimeoutMillis: RATE_LIMIT_CONNECT_TIMEOUT_MS,
      lock_timeout: LOCK_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      idleTimeoutMillis: 30000,
      // Same rule as the main pool in `@/lib/neon` — keep the two in step.
      ssl:
        process.env.DATABASE_SSL === 'strict'
          ? { rejectUnauthorized: true }
          : process.env.DATABASE_SSL === 'disable'
            ? false
            : { rejectUnauthorized: false },
    });
    _pool.on('error', (err) => {
      log.warn('rate-limit pool background error', { message: err.message }, 'rateLimit');
    });
  }
  return _pool;
}
