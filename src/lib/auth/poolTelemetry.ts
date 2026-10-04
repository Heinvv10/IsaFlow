// src/lib/auth/poolTelemetry.ts
//
// The post-deploy signal for AUTH_POOL_MAX (R-188). The four auth pools are
// small and shared by every request, so the first sign that the default is too
// small is an acquire that has to queue. Rollback: set AUTH_POOL_MAX=20 (plain
// digits; `20.0` gives 10) in the environment and restart.
import type pg from 'pg';
import { log } from '@/lib/logger';

export const POOL_SATURATED_MESSAGE = 'auth pool saturated: an acquire had to queue';
export const POOL_ACQUIRE_FAILED_MESSAGE = 'auth pool acquire failed';
export const POOL_WARN_INTERVAL_MS = 10_000;

const lastWarned = new Map<string, number>();

function counts(pool: pg.Pool, name: string) {
  return {
    pool: name, waitingCount: pool.waitingCount, totalCount: pool.totalCount,
    idleCount: pool.idleCount, max: (pool as unknown as { options?: { max?: number } }).options?.max,
  };
}

/** `pool.connect()` that reports saturation: a warning (at most once per 10 s
 *  per pool) when the acquire had to queue, an error naming the pool when it
 *  fails (typically the connection timeout). pg-pool enqueues a waiter
 *  synchronously inside connect(), so the check runs AFTER the call: before it,
 *  the first waiter on a full pool would see an empty queue. The counts logged
 *  with a failure are those taken at acquire time, not after the waiter left. */
export async function connectObserved(pool: pg.Pool, name: string): Promise<pg.PoolClient> {
  let snapshot: ReturnType<typeof counts> | undefined;
  try {
    const pending = pool.connect();
    snapshot = counts(pool, name);
    if (pool.waitingCount > 0) {
      const now = Date.now();
      const last = lastWarned.get(name);
      if (last === undefined || now - last >= POOL_WARN_INTERVAL_MS) {
        lastWarned.set(name, now);
        log.warn(POOL_SATURATED_MESSAGE, snapshot, 'pool');
      }
    }
    return await pending;
  } catch (err) {
    log.error(POOL_ACQUIRE_FAILED_MESSAGE, { ...(snapshot ?? counts(pool, name)), message: err instanceof Error ? err.message : String(err) }, 'pool');
    throw err;
  }
}
