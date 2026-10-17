/**
 * Poll while a statement is being read in the background.
 *
 * Calls `reload` every `intervalMs` while `status` is 'extracting', waiting for each call to
 * finish before the next is scheduled. Stops when the status changes (the reload brought the
 * result) or the page unmounts. A reload that fails is the caller's to report; polling goes on.
 */
import { useEffect } from 'react';

export const READ_POLL_INTERVAL_MS = 3000;

export function usePollWhileReading(
  status: string | undefined,
  reload: () => Promise<void>,
  intervalMs: number = READ_POLL_INTERVAL_MS,
): void {
  useEffect(() => {
    if (status !== 'extracting') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await reload();
      if (!stopped) timer = setTimeout(() => { void tick(); }, intervalMs);
    };
    timer = setTimeout(() => { void tick(); }, intervalMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [status, reload, intervalMs]);
}
