/**
 * Who holds a lock a migration request needs, as pg_stat_activity showed it when it was looked up, and what to do about it (R26-4, R27-3,
 * R28-2..5, B28-3..5). Every holder is named: pid, state, application, how long its transaction has been open, how long it has been idle.
 *   - Ending it is offered only for a migration transaction LEFT OPEN: the migration's own application_name (SAGE_APP_NAME, set on the CLI's
 *     pool; any client can set the same name, so it is not enough alone), idle in a transaction, seen idle in two samples at least
 *     HOLDER_CONFIRM_MS apart with its state unchanged (`confirmedIdle`: a live client between two statements moves on), and in a
 *     transaction that began before this run took its run lock (`olderThanRun`). Its client MAY be gone; that is all that is claimed.
 *   - Any other session idle in a transaction is left to whoever owns it (an application's request looks just like that between two of
 *     its statements).
 *   - A holder that is itself waiting on a lock is never "at work": it is said to be waiting, with the sessions ahead; a cycle through this
 *     run's own request is a deadlock the server breaks after deadlock_timeout.
 *   - "The server ends it" is said only from the holder's OWN role / database default (pg_db_role_setting), and as a default: a session's
 *     own SET cannot be seen from another session.
 */
import { SAGE_APP_NAME } from './sageTimeouts';

/**
 * Two samples of an idle holder this far apart, its state unchanged, make it "left open" rather than between two statements. Short
 * enough to fit inside the shortest lock wait the run meets (the number lock's 5 s) on a loaded server: the watcher samples every second
 * from 1 s on, a sample may take a second itself. A live client between two statements moves its state_change sooner.
 */
export const HOLDER_CONFIRM_MS = 2_000;

export interface LockHolder {
  pid: number;
  state?: string | null;
  app?: string | null;
  /** How long its transaction has been open, in seconds (now() - xact_start). */
  ageS?: number | null;
  /** How long it has been in its current state, in seconds (now() - state_change). */
  idleS?: number | null;
  /** state_change and xact_start, epoch ms (to compare two samples, and with when this run took its run lock). */
  stateChangeMs?: number | null;
  xactStartMs?: number | null;
  /** idle_in_transaction_session_timeout as its role's / database's default sets it (pg_db_role_setting), ms; null: none set there. */
  idleMs?: number | null;
  /** It is itself waiting on a lock (pg_blocking_pids not empty). */
  waiting?: boolean;
  /** The walk from this run's request came back to it: a lock cycle (a deadlock not broken yet). */
  cycle?: boolean;
  /** The sessions the walk found ahead of this run's request (pids), and the server's deadlock_timeout. */
  chain?: number[] | null;
  deadlockTimeout?: string | null;
  /** Seen idle in two samples HOLDER_CONFIRM_MS apart, its state unchanged (set by the watcher / the key lookup). */
  confirmedIdle?: boolean;
  /** Its transaction began before this run took its run lock (set where that time is known). */
  olderThanRun?: boolean;
}

/** The columns HOLDER_SQL and BLOCKER_SQL select from pg_stat_activity `a` for a holder, in LockHolder's names. */
export const HOLDER_COLUMNS = `a.pid, a.state, a.application_name AS app, EXTRACT(EPOCH FROM now() - a.xact_start)::int AS "ageS",
      EXTRACT(EPOCH FROM now() - a.state_change)::int AS "idleS", (EXTRACT(EPOCH FROM a.state_change) * 1000)::bigint AS "stateChangeMs",
      (EXTRACT(EPOCH FROM a.xact_start) * 1000)::bigint AS "xactStartMs", cardinality(pg_blocking_pids(a.pid)) > 0 AS "waiting",
      (SELECT s.cfg FROM pg_db_role_setting d, unnest(d.setconfig) AS s(cfg)
        WHERE s.cfg LIKE 'idle\\_in\\_transaction\\_session\\_timeout=%'
          AND ((d.setrole = a.usesysid AND d.setdatabase IN (a.datid, 0)) OR (d.setrole = 0 AND d.setdatabase = a.datid))
        ORDER BY d.setrole <> 0 DESC, d.setdatabase <> 0 DESC LIMIT 1) AS "idleDefault"`;

/** "idle_in_transaction_session_timeout=25s" (bare: ms; ms, s, min, h, d) -> ms; null when not a duration. */
export function idleSettingMs(cfg: unknown): number | null {
  const m = typeof cfg === 'string' ? /=\s*'?(\d+)\s*(ms|s|min|h|d)?'?\s*$/.exec(cfg) : null;
  if (!m) return null;
  return Number(m[1]) * { ms: 1, s: 1_000, min: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? 'ms') as 'ms'];
}

/** A row of those columns as a LockHolder; undefined when there is none (no row, or no pid). */
export function holderFrom(row: Record<string, unknown> | undefined, runLockAt?: number): LockHolder | undefined {
  if (row === undefined || typeof row.pid !== 'number') return undefined;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : null);
  const xactStartMs = num(row.xactStartMs);
  return {
    pid: row.pid, state: (row.state as string | null) ?? null, app: (row.app as string | null) ?? null, ageS: num(row.ageS), idleS: num(row.idleS),
    stateChangeMs: num(row.stateChangeMs), xactStartMs, idleMs: idleSettingMs(row.idleDefault), waiting: row.waiting === true,
    cycle: row.cycle === true, chain: Array.isArray(row.chain) ? (row.chain as number[]) : null, deadlockTimeout: (row.deadlockTimeout as string | null) ?? null,
    olderThanRun: runLockAt !== undefined && xactStartMs !== null && xactStartMs < runLockAt,
  };
}

/** The second sample of the same holder: confirmed idle when it is the same backend, idle, its state unchanged, far enough apart. */
export function confirmIdle(first: { holder: LockHolder; at: number }, next: LockHolder, at: number, apartMs = HOLDER_CONFIRM_MS): LockHolder {
  const same = first.holder.pid === next.pid && first.holder.stateChangeMs !== null && first.holder.stateChangeMs === next.stateChangeMs;
  return same && idleInTransaction(next.state) && at - first.at >= apartMs ? { ...next, confirmedIdle: true } : next;
}

export const idleInTransaction = (state: string | null | undefined): boolean => typeof state === 'string' && /^idle in transaction/.test(state);
const serverEnds = (h: LockHolder): string => (h.idleMs !== null && h.idleMs !== undefined && h.idleMs > 0
  ? `; its role's or database's default (idle_in_transaction_session_timeout ${h.idleMs / 1000} s) ends it once it has been idle that long, unless its session set its own` : '');
const seconds = (v: number | null | undefined, what: string): string => (v !== null && v !== undefined ? `, ${what} ${v} s` : '');
/** The holder named: pid, state, application, transaction age, and how long it has been idle. */
export const described = (h: LockHolder): string => `backend pid ${h.pid}${h.state ? `, ${h.state}` : ''}, application ${h.app ? h.app : '(none)'}${seconds(h.ageS, 'in a transaction for')}${idleInTransaction(h.state) ? seconds(h.idleS, 'idle for') : ''}`;

/** A migration transaction left open: our application, idle, confirmed idle across two samples, and older than this run's lock. */
export const ownLeftOpen = (h: LockHolder): boolean => h.app === SAGE_APP_NAME && idleInTransaction(h.state) && h.confirmedIdle === true && h.olderThanRun === true;

const pids = (h: LockHolder): string => (h.chain && h.chain.length > 0 ? ` (backend pids ${h.chain.join(', ')})` : '');

/** The advice for a known holder. */
export function whoHolds(h: LockHolder): string {
  if (h.cycle === true) return `${described(h)}: a lock cycle with this run's own request${pids(h)}, a deadlock the server breaks after deadlock_timeout (${h.deadlockTimeout ?? 'its setting'}); this request gives way at its lock_timeout; then re-run`;
  if (h.waiting === true) return `${described(h)}: it is itself waiting on a lock${pids(h)} and no session ahead of it could be named as the root (the server's deadlock check, deadlock_timeout ${h.deadlockTimeout ?? 'its setting'}, breaks a cycle among them); wait, then re-run`;
  if (ownLeftOpen(h)) return `${described(h)}: a migration transaction left open, from before this run (its client may be gone)${serverEnds(h)}; SELECT pg_terminate_backend(${h.pid}) ends it`;
  if (idleInTransaction(h.state)) return `${described(h)}: another session's open transaction; check with whoever owns it before ending it${serverEnds(h)}`;
  if (h.state === undefined || h.state === null) return `${described(h)} (its state could not be read): check what it is in pg_stat_activity before ending it`;
  return `${described(h)}: it is at work; wait for it to finish`;
}

/**
 * The run's OWN backend (a request whose ROLLBACK, or whose answer, did not come): its pid and the SQL that ends it. Never "the server
 * ends it": by default it does not (R27-3).
 */
export const ownBackend = (pid: number | undefined): string => (pid === undefined ? 'backend pid unknown' : `backend pid ${pid}, this run's own: SELECT pg_terminate_backend(${pid}) ends it`);
