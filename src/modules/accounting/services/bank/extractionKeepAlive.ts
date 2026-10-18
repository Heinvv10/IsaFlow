/**
 * Keep a statement row's heartbeat fresh while its job waits.
 *
 * A page read queues for a slot on the shared VLM limiter behind other reads, and one slow read can
 * take longer than STALE_AFTER_MINUTES to finish a page. Without a sign of life the row is shown as
 * interrupted, the user retries it, and the retry doubles the load on the slots it was waiting for.
 * The job beats on an interval for as long as the work is pending; when the work settles, or the process
 * is gone, the beating stops and the row goes stale as before. Work that never settles (stuck waiting for a
 * limiter slot, in a storage read, or in the progress write) must not beat for ever either, or retry and
 * delete would be refused as IN_PROGRESS until a restart: the beating also stops at a ceiling, after which
 * the row goes stale and can be retried.
 */

import { log } from '@/lib/logger';
import { maxStatementPages } from './vlmStatementPages';

/** Well inside STALE_AFTER_MINUTES (5): several beats can fail before the row looks interrupted. */
export const KEEPALIVE_INTERVAL_MS = 60_000;

/**
 * What a page may take, queueing included. One VLM request is bounded by `VLLM_TIMEOUT` (default 120 s) and a
 * page waits for a slot behind other reads, so this covers a timed-out request with room to queue. A read
 * that outlasts the page cap times this is not slow, it is stuck.
 */
export const KEEPALIVE_MS_PER_PAGE = 180_000;

/** The longest a read may keep its row alive: the page cap times the per-page budget. */
export function keepAliveCeilingMs(): number {
  return maxStatementPages() * KEEPALIVE_MS_PER_PAGE;
}

/**
 * Run `work`, calling `beat` every `everyMs` until it settles or `ceilingMs` have passed. A beat that fails
 * is logged, never fatal; a ceiling reached with the work still pending is logged and the work goes on.
 */
export async function withKeepAlive<T>(
  beat: () => Promise<void>,
  work: () => Promise<T>,
  everyMs: number = KEEPALIVE_INTERVAL_MS,
  ceilingMs: number = keepAliveCeilingMs(),
): Promise<T> {
  let beating = false;
  const timer = setInterval(() => {
    if (beating) return;
    beating = true;
    beat()
      .catch((err: unknown) => {
        log.warn('Statement keep-alive heartbeat failed', {
          error: err instanceof Error ? err.message : String(err),
        }, 'statement-extraction');
      })
      .finally(() => { beating = false; });
  }, everyMs);
  const ceiling = setTimeout(() => {
    clearInterval(timer);
    log.warn('Statement keep-alive reached its ceiling with the read still pending; the row will be shown as interrupted', {
      ceilingMs,
    }, 'statement-extraction');
  }, ceilingMs);
  // The beat must not hold the process open at shutdown.
  timer.unref?.();
  ceiling.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    clearTimeout(ceiling);
  }
}
