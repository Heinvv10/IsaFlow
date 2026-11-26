/**
 * Who holds a lock a migration request needs, as pg_stat_activity showed it when it was looked up, and what to do about it (R26-4, R27-3).
 * Ending a backend is offered only for one whose application is the migration's own (SAGE_APP_NAME, set on the CLI's pool) and that is
 * idle in a transaction: a dead run's transaction left open. "Idle in transaction" is also what any application's request looks like
 * between two of its statements (IsaFlow's own requests hold a transaction across their work), so any other holder is named (pid,
 * application, state, how long its transaction has been open) and left to whoever owns it. The server ends an idle transaction by
 * itself only when idle_in_transaction_session_timeout is set: that is said only when it is (> 0, as read with the holder).
 */
import { SAGE_APP_NAME } from './sageTimeouts';

export interface LockHolder {
  pid: number;
  state?: string | null;
  app?: string | null;
  /** How long its transaction has been open, in seconds (now() - xact_start). */
  ageS?: number | null;
  /** idle_in_transaction_session_timeout as the lookup read it, in ms (0: the server never ends an idle transaction). */
  idleMs?: number | null;
}

/** The columns HOLDER_SQL and BLOCKER_SQL select from pg_stat_activity `a` for a holder, in LockHolder's names. */
export const HOLDER_COLUMNS = `a.pid, a.state, a.application_name AS app, EXTRACT(EPOCH FROM now() - a.xact_start)::int AS "ageS",
      (SELECT setting::int FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout') AS "idleMs"`;

/** A row of those columns as a LockHolder; undefined when there is none (no row, or no pid). */
export function holderFrom(row: Record<string, unknown> | undefined): LockHolder | undefined {
  if (row === undefined || typeof row.pid !== 'number') return undefined;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
  return { pid: row.pid, state: (row.state as string | null) ?? null, app: (row.app as string | null) ?? null, ageS: num(row.ageS), idleMs: num(row.idleMs) };
}

const idleInTransaction = (state: string | null | undefined): boolean => typeof state === 'string' && /^idle in transaction/.test(state);
const serverEnds = (h: LockHolder): string => (h.idleMs !== null && h.idleMs !== undefined && h.idleMs > 0
  ? `; the server ends it once it has been idle ${h.idleMs / 1000} s (idle_in_transaction_session_timeout)` : '');
/** The holder named: pid, state, application, transaction age. */
export const described = (h: LockHolder): string => `backend pid ${h.pid}${h.state ? `, ${h.state}` : ''}, application ${h.app ? h.app : '(none)'}${h.ageS !== null && h.ageS !== undefined ? `, in a transaction for ${h.ageS} s` : ''}`;

/** Whether the holder is a migration transaction left open (the migration's own application, idle in a transaction): safe to end. */
export const ownLeftOpen = (h: LockHolder): boolean => h.app === SAGE_APP_NAME && idleInTransaction(h.state);

/** The advice for a known holder. */
export function whoHolds(h: LockHolder): string {
  if (ownLeftOpen(h)) return `${described(h)}: a migration transaction left open (its client is gone)${serverEnds(h)}; SELECT pg_terminate_backend(${h.pid}) ends it`;
  if (idleInTransaction(h.state)) return `${described(h)}: another session's open transaction; check with whoever owns it before ending it${serverEnds(h)}`;
  if (h.state === undefined || h.state === null) return `${described(h)} (its state could not be read): check what it is in pg_stat_activity before ending it`;
  return `${described(h)}: it is at work; wait for it to finish`;
}

/**
 * The run's OWN backend (a request whose ROLLBACK, or whose answer, did not come): its pid and the SQL that ends it. Never "the server
 * ends it": by default it does not (R27-3).
 */
export const ownBackend = (pid: number | undefined): string => (pid === undefined ? 'backend pid unknown' : `backend pid ${pid}, this run's own: SELECT pg_terminate_backend(${pid}) ends it`);
