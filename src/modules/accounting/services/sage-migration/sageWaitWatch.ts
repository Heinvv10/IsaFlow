/**
 * Round 25-26: no wait of a migration request is silent. While a query (or the request's connect) is IN FLIGHT, the request is watched
 * from another pool connection: when it has been waiting SAGE_WAIT_NOTICE_MS (and every such span after), `onNotice` hears it, with the
 * backend it is blocked by (pg_blocking_pids walked to its root, with that backend's state and application) when there is one. Time spent outside a query
 * (planning, the runner between batches) is never called a wait (R26-9). The blocker seen belongs to the current wait only: it is cleared
 * when nothing is in flight (R26-5), and read by the session before the query that failed on a lock is settled.
 */
import type { Pool } from 'pg';
import { log } from '@/lib/logger';
import { confirmIdle, HOLDER_COLUMNS, holderFrom, type LockHolder } from './sageLockHolder';

/** A wait this long is said, and again every time as long. */
export const SAGE_WAIT_NOTICE_MS = 5_000;
/** How often a waiting request is asked about from outside (who blocks it). */
export const BLOCKER_SAMPLE_MS = 1_000;

/**
 * The backend the request waits on (R27-3, R28-5, B28-5): pg_blocking_pids walked to the ROOT of the queue, a blocker that is not itself
 * waiting (with a queue, the first entry may be another waiter, stuck behind the same holder). The walk is a UNION on pid: each backend
 * is expanded once, so a queue costs at most one row per backend and a cycle ends it. `cycle`: the walk came back to the request itself
 * (a deadlock not broken yet); `chain`: every backend found ahead. When every one found waits, the nearest is returned, `waiting`.
 */
export const BLOCKER_SQL = `WITH RECURSIVE chain(pid) AS (
      SELECT b.pid FROM unnest(pg_blocking_pids($1)) AS b(pid)
      UNION SELECT b.pid FROM chain c, unnest(pg_blocking_pids(c.pid)) AS b(pid))
    SELECT ${HOLDER_COLUMNS}, EXISTS (SELECT 1 FROM chain WHERE pid = $1) AS "cycle",
      (SELECT array_agg(pid ORDER BY pid) FROM chain WHERE pid <> $1) AS "chain"
    FROM chain c JOIN pg_stat_activity a ON a.pid = c.pid
    WHERE c.pid <> $1
    ORDER BY cardinality(pg_blocking_pids(a.pid)) = 0 DESC, a.pid = ANY (pg_blocking_pids($1)) DESC, a.pid LIMIT 1`;

export interface WaitWatch {
  /** A query (or the connect) starts: call what it returns when it settles. */
  begin(): () => void;
  /** The request's backend, once connected (no blocker can be asked for before). */
  setPid(pid: number | undefined): void;
  /** The backend the current wait was last seen blocked by. */
  blocker(): LockHolder | undefined;
  /**
   * The backend the current wait was last seen blocked by, even if a later sample found none: the one a lock timeout is said to have
   * met. A sample that answers after the server already cancelled the statement (the end of the wait) finds nothing; that is not who
   * held it.
   */
  lastBlocker(): LockHolder | undefined;
  stop(): void;
}

/** `runLockAt`: when this run took its run lock (a holder older than that may be a dead run's, R28-4). */
export function watchWaits(pool: Pool, onNotice?: (line: string) => void, ctx: { runLockAt?: number; appName?: string } = {}): WaitWatch {
  let inFlight = 0;
  let since = 0;
  let noticed = 0;
  let pid: number | undefined;
  let blocker: LockHolder | undefined;
  let lastBlocker: LockHolder | undefined; // the last non-empty sample of this wait
  // The holder's first sample in this REQUEST (R28-4: two samples apart). Kept across the request's waits: it is matched by pid and
  // state_change, so a later wait on the same idle holder adds to the evidence; any other holder, or a state that moved, starts it over.
  let firstSeen: { holder: LockHolder; at: number } | undefined;
  let sampling = false;
  let epoch = 0; // bumped when a wait starts (R27-5): a sample that answers after its wait ended is not kept for the next one
  const canSample = typeof (pool as { query?: unknown }).query === 'function';
  const timer = setInterval(() => {
    if (inFlight === 0) return;
    const waited = Date.now() - since;
    if (waited < BLOCKER_SAMPLE_MS) return;
    if (canSample && pid !== undefined && !sampling) {
      sampling = true;
      const asked = epoch;
      pool.query<Record<string, unknown>>(BLOCKER_SQL, [pid])
        // No row: nothing blocks it now, so no earlier blocker is named for it (R27-5).
        .then((r) => {
          if (asked !== epoch || inFlight === 0) return;
          const seen = holderFrom(r.rows[0], ctx);
          if (seen === undefined || firstSeen === undefined || firstSeen.holder.pid !== seen.pid || firstSeen.holder.stateChangeMs !== seen.stateChangeMs) firstSeen = seen && { holder: seen, at: Date.now() };
          blocker = seen && firstSeen ? confirmIdle(firstSeen, seen, Date.now()) : seen;
          if (blocker !== undefined) lastBlocker = blocker;
        })
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
      if (inFlight++ === 0) { since = Date.now(); epoch++; }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        if (--inFlight === 0) { noticed = 0; blocker = undefined; lastBlocker = undefined; }
      };
    },
    setPid: (p) => { pid = p; },
    blocker: () => blocker,
    lastBlocker: () => lastBlocker,
    stop: () => clearInterval(timer),
  };
}
