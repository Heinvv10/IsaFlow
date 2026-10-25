/**
 * S-07e: `migrationAdminSqlTx` is `migrationAdminTx` with a tagged-template `tx`.
 * Every interpolation must be a bound parameter (never spliced into the text),
 * the statements run inside one BEGIN ... COMMIT on one client, a throw rolls
 * back and is rethrown, and the client goes back to the pool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values?: unknown[] }>,
  released: [] as unknown[],
  failOn: null as string | null,
}));

vi.mock('pg', () => {
  class Pool {
    on() { return this; }
    async connect() {
      return {
        query: async (text: string, values?: unknown[]) => {
          h.queries.push({ text, values });
          if (h.failOn && text.includes(h.failOn)) throw new Error('boom');
          return { rows: /^SELECT 1 AS one/.test(text) ? [{ one: 1 }] : [] };
        },
        release: (destroy?: unknown) => { h.released.push(destroy); },
      };
    }
  }
  return { default: { Pool } };
});
vi.mock('@/lib/pgTypes', () => ({}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { migrationAdminSqlTx } from '@/lib/auth/migrationAdminPool';

beforeEach(() => {
  h.queries.length = 0;
  h.released.length = 0;
  h.failOn = null;
  vi.stubEnv('MIGRATION_ADMIN_DATABASE_URL', 'postgresql://127.0.0.1:1/none');
});

describe('migrationAdminSqlTx', () => {
  it('binds every interpolation as a parameter, in one BEGIN ... COMMIT, and returns the rows', async () => {
    const hostile = `x'; DROP TABLE flow_wallet; --`;
    const rows = await migrationAdminSqlTx('test', async (tx) => {
      const first = await tx`SELECT 1 AS one WHERE ${hostile}::text IS NOT NULL AND ${7}::int > 0`;
      await tx`UPDATE flow_wallet SET balance_flows = ${5} WHERE company_id = ${'co-1'}`;
      return first;
    });

    expect(rows).toEqual([{ one: 1 }]);
    const texts = h.queries.map((q) => q.text.replace(/\s+/g, ' ').trim());
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toMatch(/SET LOCAL lock_timeout/);
    expect(texts[2]).toBe('SELECT 1 AS one WHERE $1::text IS NOT NULL AND $2::int > 0');
    expect(h.queries[2]?.values).toEqual([hostile, 7]);
    expect(texts[3]).toBe('UPDATE flow_wallet SET balance_flows = $1 WHERE company_id = $2');
    expect(h.queries[3]?.values).toEqual([5, 'co-1']);
    expect(texts[4]).toBe('COMMIT');
    expect(texts.join('|')).not.toContain('DROP TABLE');
    expect(h.released).toEqual([false]);
  });

  it('rolls back and rethrows when a statement fails, so none of the group commits', async () => {
    h.failOn = 'UPDATE flow_ledger';
    await expect(migrationAdminSqlTx('test', async (tx) => {
      await tx`UPDATE flow_wallet SET balance_flows = ${1} WHERE company_id = ${'co-1'}`;
      await tx`UPDATE flow_ledger SET reason = ${'x'}`;
    })).rejects.toThrow('boom');

    const texts = h.queries.map((q) => q.text);
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
    expect(h.released).toEqual([false]);
  });
});
