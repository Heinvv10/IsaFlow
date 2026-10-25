/**
 * S-07e part B, review round 5: every write to a route row (webhook_endpoints,
 * imap_mirror_connections, sent_mirror_connections) a delivery or a scan makes
 * goes through routeAdminQuery, on a migration_admin pool of its own. One fixed
 * statement in its own BEGIN ... COMMIT, waiting at most 2 s for a row lock
 * (transaction-local), its values bound; a failure rolls back, is rethrown, and a
 * client whose ROLLBACK failed is destroyed rather than pooled (R-176). It never
 * joins a request's transaction: inside one it still opens its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestContext } from '@/lib/als';

const h = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values?: unknown[] }>,
  released: [] as unknown[],
  failOn: null as string | null,
  pools: [] as Array<{ connectionString?: string; max?: number }>,
}));

vi.mock('pg', () => {
  class Pool {
    constructor(opts: { connectionString?: string; max?: number }) { h.pools.push(opts); }
    on() { return this; }
    async connect() {
      return {
        query: async (text: string, values?: unknown[]) => {
          h.queries.push({ text, values });
          if (h.failOn && text.includes(h.failOn)) throw Object.assign(new Error('boom'), { code: '55P03' });
          return { rows: /^UPDATE/.test(text) ? [{ id: 'r1' }] : [] };
        },
        release: (destroy?: unknown) => { h.released.push(destroy); },
      };
    }
  }
  return { default: { Pool } };
});
vi.mock('@/lib/pgTypes', () => ({}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { als } from '@/lib/als';
import { ROUTE_LOCK_WAIT, ROUTE_STATEMENT_TIMEOUT, routeAdminQuery, routeAdminTx } from '@/lib/auth/routeAdminPool';

const STAMP = 'UPDATE imap_mirror_connections SET last_scan_at = NOW() WHERE id = $1::uuid AND company_id = $2::uuid';

beforeEach(() => {
  h.queries.length = 0;
  h.released.length = 0;
  h.failOn = null;
  vi.stubEnv('MIGRATION_ADMIN_DATABASE_URL', 'postgresql://migration_admin@127.0.0.1:1/none');
});

describe('routeAdminQuery', () => {
  it('runs one statement in its own transaction that waits 2 s for a row lock and runs 10 s at most, with its values bound, and returns the rows', async () => {
    const rows = await routeAdminQuery('stamp', STAMP, ['c1', 'co1']);
    expect(rows).toEqual([{ id: 'r1' }]);
    expect(h.queries.map((q) => q.text)).toEqual(['BEGIN', "SET LOCAL lock_timeout = '2s'", "SET LOCAL statement_timeout = '10s'", STAMP, 'COMMIT']);
    expect(ROUTE_LOCK_WAIT).toBe('2s');
    expect(ROUTE_STATEMENT_TIMEOUT).toBe('10s');
    expect(h.queries[3]!.values).toEqual(['c1', 'co1']);
    expect(h.released).toEqual([false]);
  });

  it('is a pool of its own on the migration_admin login (default 3), not the credential pool', async () => {
    await routeAdminQuery('stamp', STAMP, ['c1', 'co1']);
    expect(h.pools).toHaveLength(1);
    expect(h.pools[0]).toMatchObject({ connectionString: 'postgresql://migration_admin@127.0.0.1:1/none', max: 3 });
  });

  it('a failure (a lock wait that ran out) rolls back and is rethrown with its code; the client is pooled again', async () => {
    h.failOn = 'UPDATE';
    await expect(routeAdminQuery('stamp', STAMP, ['c1', 'co1'])).rejects.toMatchObject({ code: '55P03' });
    expect(h.queries.map((q) => q.text)).toEqual(['BEGIN', "SET LOCAL lock_timeout = '2s'", "SET LOCAL statement_timeout = '10s'", STAMP, 'ROLLBACK']);
    expect(h.released).toEqual([false]);
  });

  it('a client whose ROLLBACK fails is destroyed, not pooled (R-176)', async () => {
    h.failOn = 'ROLLBACK'; // the statement below names it too, so it fails, and then so does the ROLLBACK
    await expect(routeAdminQuery('stamp', 'UPDATE x SET y = 1 WHERE note = \'ROLLBACK\'', [])).rejects.toMatchObject({ code: '55P03' });
    expect(h.queries.map((q) => q.text).at(-1)).toBe('ROLLBACK');
    expect(h.released).toHaveLength(1);
    expect(h.released[0]).toBeTruthy();
  });

  it('inside a request it still opens its own transaction (it never joins the request\'s)', async () => {
    const ctx: RequestContext = { client: { query: vi.fn() } as unknown as RequestContext['client'], userId: 'u1', claims: {}, afterCommit: [] };
    await als.run(ctx, () => routeAdminQuery('stamp', STAMP, ['c1', 'co1']));
    expect(h.queries[0]!.text).toBe('BEGIN');
    expect(vi.mocked(ctx.client!.query)).not.toHaveBeenCalled();
  });

  it('routeAdminTx runs several statements in ONE transaction with the same bounds; a failure part-way rolls all of it back', async () => {
    const out = await routeAdminTx('two writes', async (client) => {
      await client.query(STAMP, ['c1', 'co1']);
      return (await client.query('SELECT 1', [])).rows;
    });
    expect(out).toEqual([]);
    expect(h.queries.map((q) => q.text)).toEqual([
      'BEGIN', "SET LOCAL lock_timeout = '2s'", "SET LOCAL statement_timeout = '10s'", STAMP, 'SELECT 1', 'COMMIT',
    ]);
    h.queries.length = 0;
    h.failOn = 'SELECT 1';
    await expect(routeAdminTx('two writes', async (client) => {
      await client.query(STAMP, ['c1', 'co1']);
      await client.query('SELECT 1', []);
    })).rejects.toMatchObject({ code: '55P03' });
    expect(h.queries.map((q) => q.text).at(-1)).toBe('ROLLBACK');
    expect(h.queries.map((q) => q.text)).not.toContain('COMMIT');
  });
});
