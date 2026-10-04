/**
 * R-184 — splitting src/lib/neon.ts must not change what `@/lib/neon` is.
 *
 * 1. The runtime export names are exactly the ones origin/master exported before the split
 *    (pinned from 1910c157b; green against the unsplit file in docs/audits/remediation/R-184/red.unit.log), and the re-exports
 *    are the very same functions as their sources.
 * 2. Module state lives once. Every entry point that reaches the pool shares ONE pg.Pool, and
 *    every entry point that looks for a request transaction reads the SAME AsyncLocalStorage, so a
 *    query issued through the barrel inside withTransaction/withSavepoint/sql.transaction lands
 *    on the same client those helpers use. A module that built its own pool or ALS would pass a
 *    type-check and fail here.
 * 3. Importing the barrel still registers the DATE (1082) type parser (`@/lib/pgTypes`).
 *
 * Real pg-pool, reached through `pg`; only the client is a fake that records its queries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({ state: { pools: 0, connects: 0, queries: [] as string[] } }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg')>();
  type Cb = (err: Error | null, res?: { rows: unknown[] }) => void;
  class FakeClient {
    connect(cb: (err?: Error) => void): void { state.connects += 1; cb(); }
    query(text: string, _values: unknown, cb?: Cb): Promise<{ rows: unknown[] }> | void {
      state.queries.push(`pool:${text}`);
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
    constructor(options: object) { state.pools += 1; super({ ...options, Client: FakeClient as never }); }
  }
  return { ...actual, default: { ...actual.default, Pool } };
});

/** Names exported by src/lib/neon.ts at 1910c157b, before the split. */
const PINNED_EXPORTS = [
  'assertTxUsable', 'default', 'fmtDate', 'getDbPool', 'getPool', 'getPoolForTests', 'sql', 'transaction',
  'withSavepoint', 'withTransaction',
];

beforeEach(() => {
  state.pools = 0;
  state.connects = 0;
  state.queries.length = 0;
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgresql://127.0.0.1:1/none');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('R-184: the @/lib/neon export surface is unchanged', () => {
  it('exports exactly the names origin/master exported', async () => {
    const neon = await import('@/lib/neon');
    expect(Object.keys(neon).sort()).toEqual(PINNED_EXPORTS);
  });

  it('re-exports are the source functions themselves, and default is sql', async () => {
    const neon = await import('@/lib/neon');
    expect(neon.default).toBe(neon.sql);
    expect(neon.assertTxUsable).toBe((await import('@/lib/als')).assertTxUsable);
    expect(neon.fmtDate).toBe((await import('@/lib/fmtDate')).fmtDate);
  });
});

describe('R-184: one pool and one request context behind every entry point', () => {
  it('every pool accessor returns the same pg.Pool, and every query path outside a request uses it', async () => {
    const { getPool, getDbPool, getPoolForTests, sql, transaction, withTransaction } = await import('@/lib/neon');
    const pool = getPool();
    expect(getDbPool()).toBe(pool);
    expect(getPoolForTests()).toBe(pool);

    await sql`SELECT 'bare'`;
    await sql.transaction([sql`SELECT 'batch'`]);
    await transaction((tx) => [tx`SELECT 'helper'`]);
    await withTransaction(async (tx) => { await tx`SELECT 'tx'`; await sql`SELECT 'nested'`; });

    expect(state.pools).toBe(1);
    expect(state.queries).toEqual(expect.arrayContaining([
      "pool:SELECT 'bare'", "pool:SELECT 'batch'", "pool:SELECT 'helper'", "pool:SELECT 'tx'", "pool:SELECT 'nested'",
    ]));
    expect(state.queries.filter((q) => q === 'pool:COMMIT')).toHaveLength(3);
  });

  it('inside a request every helper, and sql issued through the barrel within it, runs on the ALS client', async () => {
    const { sql, transaction, withTransaction, withSavepoint } = await import('@/lib/neon');
    const { als } = await import('@/lib/als');
    const onCtx: string[] = [];
    const client = { query: vi.fn(async (text: string) => { onCtx.push(text); return { rows: [] }; }) };
    const ctx = { client, userId: 'u', companyId: 'c', claims: {} } as unknown as Parameters<typeof als.run>[0];

    await als.run(ctx, async () => {
      await sql`SELECT 'bare'`;
      await sql.transaction([sql`SELECT 'batch'`]);
      await transaction((tx) => [tx`SELECT 'helper'`]);
      await withTransaction(async (tx) => { await tx`SELECT 'tx'`; await sql`SELECT 'nested'`; });
      await withSavepoint('r184_sp', async () => { await sql`SELECT 'sp'`; });
    });

    expect(onCtx.filter((q) => !/SAVEPOINT/.test(q))).toEqual([
      "SELECT 'bare'", "SELECT 'batch'", "SELECT 'helper'", "SELECT 'tx'", "SELECT 'nested'", "SELECT 'sp'",
    ]);
    expect(onCtx).toContain('SAVEPOINT r184_sp');
    expect(state.pools).toBe(0);
    expect(state.queries).toEqual([]);
  });

  it('sql.transaction savepoint names keep counting across calls (one counter, not one per call)', async () => {
    const { sql } = await import('@/lib/neon');
    const { als } = await import('@/lib/als');
    const onCtx: string[] = [];
    const client = { query: vi.fn(async (text: string) => { onCtx.push(text); return { rows: [] }; }) };
    const ctx = { client, userId: 'u', companyId: 'c', claims: {} } as unknown as Parameters<typeof als.run>[0];
    await als.run(ctx, async () => {
      await sql.transaction([sql`SELECT 1`]);
      await sql.transaction([sql`SELECT 2`]);
    });
    const names = onCtx.filter((q) => q.startsWith('SAVEPOINT ')).map((q) => q.slice('SAVEPOINT '.length));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });
});

describe('R-184: importing the barrel registers the DATE parser', () => {
  it('a DATE value parses to its YYYY-MM-DD text, not a Date', async () => {
    const pg = (await import('pg')).default;
    pg.types.setTypeParser(1082, (v: string) => new Date(v));
    await import('@/lib/neon');
    expect(pg.types.getTypeParser(1082, 'text')('2026-10-03')).toBe('2026-10-03');
  });
});
