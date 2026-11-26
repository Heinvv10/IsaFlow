/**
 * Round 25: no wait of a migration request is silent. While a request runs, its own backend is watched from another pool connection: when
 * no query of it has answered for SAGE_WAIT_NOTICE_MS (and every such span after), `onNotice` hears it, with the backend it is blocked by
 * (pg_blocking_pids) when there is one. The blocker last seen is kept, so a lock timeout (55P03) can name its holder.
 */
import type { Pool } from 'pg';
import { log } from '@/lib/logger';

/** A request with no answer for this long is said, and again every time as long. */
export const SAGE_WAIT_NOTICE_MS = 5_000;
/** How often a request with no answer is asked about from outside (who blocks it). */
export const BLOCKER_SAMPLE_MS = 1_000;

export interface WaitWatch {
  /** A query of the request answered (or failed): the wait starts over. */
  touch(): void;
  /** The backend the request was last seen blocked by, if it was. */
  blocker(): number | undefined;
  stop(): void;
}

export function watchWaits(pool: Pool, pid: number | undefined, onNotice?: (line: string) => void): WaitWatch {
  let last = Date.now();
  let noticed = 0;
  let blocker: number | undefined;
  let sampling = false;
  const canSample = pid !== undefined && typeof (pool as { query?: unknown }).query === 'function';
  const timer = setInterval(() => {
    const waited = Date.now() - last;
    if (waited < BLOCKER_SAMPLE_MS) return;
    if (canSample && !sampling) {
      sampling = true;
      pool.query<{ p: number[] | null }>('SELECT pg_blocking_pids($1) AS p', [pid])
        .then((r) => { const p = r.rows[0]?.p?.[0]; if (typeof p === 'number') blocker = p; })
        .catch((err: unknown) => log.warn('sage migration: who blocks the request could not be read', { message: err instanceof Error ? err.message : String(err) }, 'sage-migration'))
        .finally(() => { sampling = false; });
    }
    const span = Math.floor(waited / SAGE_WAIT_NOTICE_MS);
    if (span > noticed) {
      noticed = span;
      onNotice?.(`a database request has had no answer for ${span * (SAGE_WAIT_NOTICE_MS / 1000)} s${blocker === undefined ? '' : `; it is blocked by backend pid ${blocker}`}`);
    }
  }, BLOCKER_SAMPLE_MS / 2);
  timer.unref?.();
  return {
    touch: () => { last = Date.now(); noticed = 0; },
    blocker: () => blocker,
    stop: () => clearInterval(timer),
  };
}
