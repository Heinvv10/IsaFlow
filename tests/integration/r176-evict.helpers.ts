/**
 * R-176 shared pieces: make a transaction owner's ROLLBACK / COMMIT / BEGIN fail on its own
 * client, and read what became of the backend afterwards.
 */
import pg, { type Pool, type PoolClient } from 'pg';

export type Statement = 'ROLLBACK' | 'COMMIT';
/** What one run saw: its backend, how often each statement was refused, and the disarm. */
export interface Seen {
  pid: number; refused: Record<Statement, number>; beginFailed: number; disarm: () => void;
}
export const seen = (): Seen =>
  ({ pid: 0, refused: { ROLLBACK: 0, COMMIT: 0 }, beginFailed: 0, disarm: () => undefined });

export interface ArmOptions {
  /** Refuse each statement at most this many times; later ones go through. */
  times?: number;
  /** BEGIN reaches the server and opens the transaction; the client is then told it failed. */
  beginFailsAfterSend?: boolean;
}

/**
 * Refuses the given statements on this client before they reach Postgres, as a client-side
 * timeout on a queued query does. Everything else goes through.
 */
export function arm(client: PoolClient, fail: Statement[], s: Seen, opts: ArmOptions = {}): void {
  const real = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
  const patched = (...a: unknown[]) => {
    const text = a[0];
    if ((text === 'ROLLBACK' || text === 'COMMIT') && fail.includes(text)
      && s.refused[text] < (opts.times ?? Infinity)) {
      s.refused[text] += 1;
      return Promise.reject(new Error(`R-176 forced: ${text} never reached the server`));
    }
    if (opts.beginFailsAfterSend && typeof text === 'string' && text.startsWith('BEGIN') && s.beginFailed === 0) {
      s.beginFailed += 1;
      return real(...a).then(() => { throw new Error('R-176 forced: BEGIN reached the server, then failed client-side'); });
    }
    return real(...a);
  };
  Object.assign(client, { query: patched });
  const before = s.disarm;
  s.disarm = () => { Object.assign(client, { query: real }); before(); };
}

/**
 * For an owner whose client the test cannot reach: the next `await pool.connect()` on this pool
 * is noted (its backend pid) and armed. One checkout only; the pool's own connect goes back at once.
 */
export function armNextCheckout(pool: Pool, fail: Statement[], s: Seen, opts: ArmOptions = {}): void {
  const real = pool.connect.bind(pool) as (...a: unknown[]) => Promise<PoolClient>;
  const restore = () => { Object.assign(pool, { connect: real }); };
  s.disarm = restore;
  Object.assign(pool, {
    connect: (...a: unknown[]) => {
      if (a.length > 0) return real(...a); // pool.query's own callback checkout is not the owner's
      restore();
      return real().then((client) => {
        s.pid = (client as unknown as { processID: number }).processID;
        arm(client, fail, s, opts);
        return client;
      });
    },
  });
}

/**
 * For an owner whose POOL the test cannot reach either: every `await pool.connect()` on any pool
 * is armed until disarm. `pool.query` checks out with a callback and is left alone, so only a
 * transaction owner's own client is touched.
 */
export function armAllCheckouts(fail: Statement[], s: Seen, opts: ArmOptions = {}): void {
  const proto = pg.Pool.prototype as unknown as { connect: (...a: unknown[]) => unknown };
  const before = proto.connect;
  s.disarm = () => { proto.connect = before; };
  proto.connect = function armed(this: unknown, ...a: unknown[]) {
    const out = before.apply(this, a);
    if (a.length > 0) return out;
    return (out as Promise<PoolClient>).then((client) => {
      s.pid = (client as unknown as { processID: number }).processID;
      arm(client, fail, s, opts);
      return client;
    });
  };
}

/** The backend's state in pg_stat_activity, or null once it is gone. Waits up to `ms` for `want`. */
export async function backendState(admin: Pool, pid: number, want: 'gone' | 'idle', ms = 1000): Promise<string | null> {
  let state: string | null = null;
  for (let i = 0; i < ms / 25; i += 1) {
    const rows = (await admin.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid])).rows;
    state = rows.length === 0 ? null : String(rows[0].state);
    if ((want === 'gone') === (state === null) && state !== 'active') return state;
    await new Promise((done) => setTimeout(done, 25));
  }
  return state;
}
