/**
 * Round 25-26: no wait of a migration request is silent. While a query (or the request's connect) is IN FLIGHT, the request is watched
 * from another pool connection: when it has been waiting SAGE_WAIT_NOTICE_MS (and every such span after), `onNotice` hears it, with the
 * backend it is blocked by (pg_blocking_pids, with that backend's state and application) when there is one. Time spent outside a query
 * (planning, the runner between batches) is never called a wait (R26-9). The blocker seen belongs to the current wait only: it is cleared
 * when nothing is in flight (R26-5), and read by the session before the query that failed on a lock is settled.
 */
import type { Pool } from 'pg';
import { log } from '@/lib/logger';
import type { LockHolder } from './sageSessionErrors';

/** A wait this long is said, and again every time as long. */
export const SAGE_WAIT_NOTICE_MS = 5_000;
/** How often a waiting request is asked about from outside (who blocks it). */
export const BLOCKER_SAMPLE_MS = 1_000;

export const BLOCKER_SQL = `SELECT a.pid, a.state, a.application_name AS app FROM pg_stat_activity a WHERE a.pid = ANY(pg_blocking_pids($1)) LIMIT 1`;

export interface WaitWatch {
  /** A query (or the connect) starts: call what it returns when it settles. */
  begin(): () => void;
  /** The request's backend, once connected (no blocker can be asked for before). */
  setPid(pid: number | undefined): void;
  /** The backend the current wait was last seen blocked by. */
  blocker(): LockHolder | undefined;
  stop(): void;
}

export function watchWaits(pool: Pool, onNotice?: (line: string) => void): WaitWatch {
  let inFlight = 0;
  let since = 0;
  let noticed = 0;
  let pid: number | undefined;
  let blocker: LockHolder | undefined;
  let sampling = false;
  const canSample = typeof (pool as { query?: unknown }).query === 'function';
  const timer = setInterval(() => {
    if (inFlight === 0) return;
    const waited = Date.now() - since;
    if (waited < BLOCKER_SAMPLE_MS) return;
    if (canSample && pid !== undefined && !sampling) {
      sampling = true;
      pool.query<{ pid: number; state: string | null; app: string | null }>(BLOCKER_SQL, [pid])
        .then((r) => { const row = r.rows[0]; if (row && inFlight > 0) blocker = { pid: row.pid, state: row.state, app: row.app }; })
        .catch((err: unknown) => log.warn('sage migration: who blocks the request could not be read', { message: err instanceof Error ? err.message : String(err) }, 'sage-migration'))
        .finally(() => { sampling = false; });
    }
    const span = Math.floor(waited / SAGE_WAIT_NOTICE_MS);
    if (span > noticed) {
      noticed = span;
      onNotice?.(`a database request has had no answer for ${span * (SAGE_WAIT_NOTICE_MS / 1000)} s${blocker === undefined ? '' : `; it is blocked by backend pid ${blocker.pid}`}`);
    }
  }, BLOCKER_SAMPLE_MS / 2);
  timer.unref?.();
  return {
    begin: () => {
      if (inFlight++ === 0) since = Date.now();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        if (--inFlight === 0) { noticed = 0; blocker = undefined; }
      };
    },
    setPid: (p) => { pid = p; },
    blocker: () => blocker,
    stop: () => clearInterval(timer),
  };
}
