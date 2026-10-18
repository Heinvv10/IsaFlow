/**
 * Keep a statement row's heartbeat fresh while its job waits.
 *
 * A page read queues for a slot on the shared VLM limiter behind other reads, and one slow read can
 * take longer than STALE_AFTER_MINUTES to finish a page. Without a sign of life the row is shown as
 * interrupted, the user retries it, and the retry doubles the load on the slots it was waiting for.
 * The job beats on an interval for as long as the work is pending; when the work settles, or the process
 * is gone, the beating stops and the row goes stale as before. (A read that hangs inside the process is
 * bounded by the VLM request timeout, which fails the page, so it cannot beat for ever.)
 */

import { log } from '@/lib/logger';

/** Well inside STALE_AFTER_MINUTES (5): several beats can fail before the row looks interrupted. */
export const KEEPALIVE_INTERVAL_MS = 60_000;

/** Run `work`, calling `beat` every `everyMs` until it settles. A beat that fails is logged, never fatal. */
export async function withKeepAlive<T>(
  beat: () => Promise<void>,
  work: () => Promise<T>,
  everyMs: number = KEEPALIVE_INTERVAL_MS,
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
  // The beat must not hold the process open at shutdown.
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
