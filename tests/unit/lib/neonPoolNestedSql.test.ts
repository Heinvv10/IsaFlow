/**
 * R-182: why PG_POOL_MAX has a floor of 2. Outside a request, `withTransaction`
 * holds one connection of the main pool, and a bare `sql` inside its callback
 * (no request context, so it goes to `getPool()`) needs a SECOND one from the
 * same pool. With a pool of 1 that second acquire waits out the connect timeout
 * while the first is held. Real pg-pool, reached through `pg`; only the client
 * is a fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connects } = vi.hoisted(() => ({ connects: { count: 0 } }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg')>();
  type Cb = (err: Error | null, res?: { rows: unknown[] }) => void;
  class FakeClient {
    connect(cb: (err?: Error) => void): void { connects.count += 1; cb(); }
    query(_text: string, _values: unknown, cb?: Cb): Promise<{ rows: unknown[] }> | void {
      const res = { rows: [] };
      if (typeof cb === 'function') { cb(null, res); return undefined; }
      return Promise.resolve(res);
    }
    on(): this { return this; }
    once(): this { return this; }
    removeListener(): this { return this; }
    end(): void { /* nothing to close */ }
  }
  class Pool extends actual.default.Pool {
    constructor(options: object) { super({ ...options, Client: FakeClient as never }); }
  }
  return { ...actual, default: { ...actual.default, Pool } };
});

beforeEach(() => {
  connects.count = 0;
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgresql://127.0.0.1:1/none');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function nestedSqlInsideWithTransaction() {
  const { withTransaction, sql } = await import('@/lib/neon');
  return withTransaction(async () => { await sql`SELECT 1`; return 'ok'; });
}

describe('a bare sql inside withTransaction outside a request (R-182)', () => {
  it('pg-pool premise: with its one connection held, a size-1 pool times out on a second acquire', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // A requested size of 1 is raised to the floor, so build a size-1 pool the
    // way the old Number() reader did, to show the mechanism the floor prevents.
    const pg = (await import('pg')).default;
    const one = new pg.Pool({ max: 1, connectionTimeoutMillis: 15000 });
    const held = await one.connect();
    const second = one.query('SELECT 1');
    const settled = second.then(() => 'resolved', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(15001);
    expect(await settled).toMatch(/timeout/i);
    held.release();
    await one.end();
  });

  it.each(['1', '1.0', '0.5'])('PG_POOL_MAX=%j is raised to 2, so the nested sql completes', async (raw) => {
    vi.stubEnv('PG_POOL_MAX', raw);
    await expect(nestedSqlInsideWithTransaction()).resolves.toBe('ok');
    const { getPool } = await import('@/lib/neon');
    expect(getPool().options.max).toBe(2);
    // Both connections were used: the held transaction client and the bare sql's.
    expect(connects.count).toBe(2);
  });
});
