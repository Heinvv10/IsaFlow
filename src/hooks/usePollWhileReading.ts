/**
 * Poll while a statement is being read in the background.
 *
 * Calls `reload` every `intervalMs` while `status` is 'extracting', waiting for each call to
 * finish before the next is scheduled. Stops when the status changes (the reload brought the
 * result), the page unmounts, or `reload` answers 'stop' (the statement is gone or not ours: 404/403).
 * A poll that answers 'bad' (a server error, a restart, a dropped connection) is not the end of the
 * read, which goes on in the background: the next poll waits twice as long as the last, up to
 * MAX_BACKOFF_MS, and the first good poll returns to `intervalMs`. The caller shows the error meanwhile.
 */
import { useEffect } from 'react';

export const READ_POLL_INTERVAL_MS = 3000;
export const MAX_BACKOFF_MS = 60_000;

/** What one poll found. Anything else (undefined) counts as 'ok'. */
export type PollOutcome = 'ok' | 'bad' | 'stop' | undefined;

export function usePollWhileReading(
  status: string | undefined,
  reload: () => Promise<PollOutcome>,
  intervalMs: number = READ_POLL_INTERVAL_MS,
): void {
  useEffect(() => {
    if (status !== 'extracting') return;
    let stopped = false;
    let wait = intervalMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const outcome = await reload();
      wait = outcome === 'bad' ? Math.min(wait * 2, MAX_BACKOFF_MS) : intervalMs;
      if (outcome === 'stop') stopped = true;
      if (!stopped) timer = setTimeout(() => { void tick(); }, wait);
    };
    timer = setTimeout(() => { void tick(); }, intervalMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [status, reload, intervalMs]);
}
