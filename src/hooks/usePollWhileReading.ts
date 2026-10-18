/**
 * Poll while a statement is being read in the background.
 *
 * Calls `reload` every `intervalMs` while `status` is 'extracting', waiting for each call to
 * finish before the next is scheduled. Stops when the status changes (the reload brought the
 * result), the page unmounts, `reload` answers 'stop' (the statement is gone or not ours: 404/403),
 * or it answers 'bad' MAX_FAILURES_IN_A_ROW times running. The caller shows why; a poll that
 * cannot succeed must not hammer the server for as long as the tab stays open.
 */
import { useEffect } from 'react';

export const READ_POLL_INTERVAL_MS = 3000;
export const MAX_FAILURES_IN_A_ROW = 3;

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
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const outcome = await reload();
      failures = outcome === 'bad' ? failures + 1 : 0;
      if (outcome === 'stop' || failures >= MAX_FAILURES_IN_A_ROW) stopped = true;
      if (!stopped) timer = setTimeout(() => { void tick(); }, intervalMs);
    };
    timer = setTimeout(() => { void tick(); }, intervalMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [status, reload, intervalMs]);
}
