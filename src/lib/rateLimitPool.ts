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

/** Connections per process. One statement of about a millisecond each, so a few go a long way. */
export const RATE_LIMIT_POOL_MAX = 3;

/**
 * How long a limiter call waits for a connection before it throws. A throw is
 * what a database error has always been here: the caller's request fails, it is
 * never admitted unchecked.
 */
export const RATE_LIMIT_CONNECT_TIMEOUT_MS = 5000;

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
