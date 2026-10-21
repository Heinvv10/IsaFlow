/**
 * Bounds on what Netcash sends hold (AP-01 round 11). A send holds its request's connection (the auth pool) and its
 * claim's connection (the main pool, PG_POOL_MAX, default 10) for up to the 30 s send timeout, so:
 *   - at most NETCASH_MAX_CONCURRENT_SENDS (default 3) sends are in flight per process, and at most
 *     NETCASH_MAX_CONCURRENT_SENDS_PER_COMPANY (default 2, never above the process cap) per company, so one tenant
 *     cannot take every slot (round 12); the next is refused before it checks out a connection (`takeSendSlot`);
 *   - the claim's connection is checked out within a bound or not at all (`connectWithin`).
 * In-process: production runs one Next.js process. Each refusal happens before anything is claimed or sent.
 */
import type { Pool, PoolClient } from 'pg';
import { log } from '@/lib/logger';
import { poolSizeFromEnv } from '@/lib/limits/poolLimits';

const DEFAULT_MAX_CONCURRENT_SENDS = 3;
const DEFAULT_MAX_CONCURRENT_SENDS_PER_COMPANY = 2;
let inFlight = 0;
const inFlightByCompany = new Map<string, number>();

/** The cap, read per call (a whole number from 1; anything else falls back, warned once). */
export function maxConcurrentSends(): number {
  return poolSizeFromEnv('NETCASH_MAX_CONCURRENT_SENDS', DEFAULT_MAX_CONCURRENT_SENDS, 'netcash', 1);
}

/** The per-company cap, read per call (a whole number from 1, never above the process cap). */
export function maxConcurrentSendsPerCompany(): number {
  return Math.min(maxConcurrentSends(),
    poolSizeFromEnv('NETCASH_MAX_CONCURRENT_SENDS_PER_COMPANY', DEFAULT_MAX_CONCURRENT_SENDS_PER_COMPANY, 'netcash', 1));
}

/**
 * A slot for one send of `companyId`, or which cap refused it. The returned `free` releases the slot once, however
 * often it is called.
 */
export function takeSendSlot(companyId: string): { free: () => void } | { refused: 'process' | 'company' } {
  const mine = inFlightByCompany.get(companyId) ?? 0;
  if (inFlight >= maxConcurrentSends()) return { refused: 'process' };
  if (mine >= maxConcurrentSendsPerCompany()) return { refused: 'company' };
  inFlight += 1;
  inFlightByCompany.set(companyId, mine + 1);
  let freed = false;
  return {
    free: () => {
      if (freed) return;
      freed = true;
      inFlight -= 1;
      const left = (inFlightByCompany.get(companyId) ?? 1) - 1;
      if (left > 0) inFlightByCompany.set(companyId, left);
      else inFlightByCompany.delete(companyId);
    },
  };
}

/**
 * A pooled connection within `ms`, or null. A checkout still queued when the bound passes is not abandoned: the
 * connection it gets later is handed straight back (it never ran a statement), and its failure is logged.
 */
export async function connectWithin(pool: Pool, ms: number): Promise<PoolClient | null> {
  const pending = pool.connect();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    const won = await Promise.race([pending, timedOut]);
    if (won) return won;
  } finally {
    clearTimeout(timer);
  }
  pending.then(
    (late) => late.release(),
    (err: unknown) => log.warn('netcash claim connection checkout failed after its bound', { error: String(err) }, 'netcash'),
  );
  return null;
}
