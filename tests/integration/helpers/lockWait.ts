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
