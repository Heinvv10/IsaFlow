/**
 * Two-connection race helpers: wait (bounded) until a backend is blocked on a lock, read from
 * pg_stat_activity, so a race test proves the wait instead of sleeping and hoping.
 */
import type { Pool, PoolClient } from 'pg';

export async function backendPid(c: PoolClient): Promise<number> {
  return (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
}

/** Resolves once `pid` waits on a heavyweight lock; throws after `ms`. */
export async function waitUntilBlocked(observer: Pool, pid: number, ms = 10000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    const r = await observer.query<{ w: string | null }>('SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (r.rows[0]?.w === 'Lock') return;
    if (Date.now() > until) throw new Error(`backend ${pid} never blocked on a lock within ${ms}ms`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

/** Settles a pending query into its SQLSTATE (or 'ok'). */
export async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    return e.constraint ? `${e.code}:${e.constraint}` : String(e.code);
  }
}

/**
 * What a backend is blocked on (#1701 round 9): polls pg_blocking_pids until `pid` is blocked BY `blockerPid` and
 * returns the type of the lock it waits for (pg_locks: 'advisory' for a credit-note key, 'transactionid' for a row held
 * by another transaction), or null when `p` settles first or nothing blocks it within 5 s. A race test asserts the TYPE,
 * so it cannot pass on an incidental wait (a foreign key's row lock) the fix under test does not take.
 */
export async function lockWaitOf(observer: Pool, pid: number, blockerPid: number, p: Promise<unknown>): Promise<string | null> {
  let settled = false;
  void p.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + 5000;
  while (!settled && Date.now() < deadline) {
    const r = await observer.query(
      `SELECT l.locktype FROM pg_locks l
       WHERE l.pid = $1 AND NOT l.granted AND $2 = ANY(pg_blocking_pids($1)) LIMIT 1`, [pid, blockerPid]);
    if (r.rowCount) return String(r.rows[0].locktype);
    await observer.query('SELECT pg_sleep(0.02)');
  }
  return null;
}
