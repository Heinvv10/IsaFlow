/**
 * R-176 shared pieces: refuse a transaction owner's ROLLBACK / COMMIT on its own client before
 * the statement reaches Postgres (as a client-side timeout does), and read what became of the
 * backend afterwards.
 */
import type { Pool, PoolClient } from 'pg';

export type Statement = 'ROLLBACK' | 'COMMIT';
/** What one run saw: its backend, how often each statement was refused, and the disarm. */
export interface Seen { pid: number; refused: Record<Statement, number>; disarm: () => void }
export const seen = (): Seen => ({ pid: 0, refused: { ROLLBACK: 0, COMMIT: 0 }, disarm: () => undefined });

/** Refuses the given statements on this client. Everything else goes through. */
export function arm(client: PoolClient, fail: Statement[], s: Seen): void {
  const real = client.query.bind(client) as (...a: unknown[]) => unknown;
  const patched = (...a: unknown[]) => {
    const text = a[0];
    if ((text === 'ROLLBACK' || text === 'COMMIT') && fail.includes(text)) {
      s.refused[text] += 1;
      return Promise.reject(new Error(`R-176 forced: ${text} never reached the server`));
    }
    return real(...a);
  };
  Object.assign(client, { query: patched });
  s.disarm = () => { Object.assign(client, { query: real }); };
}

/**
 * For an owner whose client the test cannot reach: the next `await pool.connect()` on this pool
 * is noted (its backend pid) and armed. One checkout only; the pool's own connect goes back at once.
 */
export function armNextCheckout(pool: Pool, fail: Statement[], s: Seen): void {
  const real = pool.connect.bind(pool) as (...a: unknown[]) => Promise<PoolClient>;
  const restore = () => { Object.assign(pool, { connect: real }); };
  s.disarm = restore;
  Object.assign(pool, {
    connect: (...a: unknown[]) => {
      if (a.length > 0) return real(...a); // pool.query's own callback checkout is not the owner's
      restore();
      return real().then((client) => {
        s.pid = (client as unknown as { processID: number }).processID;
        arm(client, fail, s);
        return client;
      });
    },
  });
}

/** The backend's state in pg_stat_activity, or null once it is gone. Waits for `want`. */
export async function backendState(admin: Pool, pid: number, want: 'gone' | 'idle'): Promise<string | null> {
  let state: string | null = null;
  for (let i = 0; i < 40; i += 1) {
    const rows = (await admin.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid])).rows;
    state = rows.length === 0 ? null : String(rows[0].state);
    if ((want === 'gone') === (state === null) && state !== 'active') return state;
    await new Promise((done) => setTimeout(done, 25));
  }
  return state;
}
