/**
 * withTransaction must run on the request-scoped client when one is in flight.
 *
 * Why: withAuth wraps every request in BEGIN … COMMIT on an ALS-bound client.
 * withTransaction used to grab a SECOND pool connection and BEGIN there, so a
 * row written by sql`` earlier in the same request was invisible to it —
 * `allocateTransaction` hit `bank_transactions_matched_journal_line_id_fkey`
 * on every UI/MCP allocation from 2026-06-10 until this fix. It also
 * COMMITted on its own, breaking withAuth's all-or-nothing contract.
 *
 * DB-gated part reproduces the exact FK shape with a real parent/child pair.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { withTransaction, getPoolForTests, sql } from '@/lib/neon';

type Ctx = Parameters<typeof als.run>[0];
function fakeCtx(client: unknown): Ctx {
  return { client, userId: 'u', companyId: 'c', claims: {} } as unknown as Ctx;
}

describe('withTransaction — request tx in flight (unit, mocked client)', () => {
  const queries: string[] = [];
  const client = { query: vi.fn(async (text: string) => { queries.push(text); return { rows: [] }; }) };
  beforeEach(() => { queries.length = 0; client.query.mockClear(); });

  it('uses a SAVEPOINT on the ALS client and never BEGIN/COMMITs', async () => {
    const result = await als.run(fakeCtx(client), () =>
      withTransaction(async (tx) => { await tx`SELECT 1`; return 'ok'; }),
    );
    expect(result).toBe('ok');
    expect(queries[0]).toMatch(/^SAVEPOINT /);
    expect(queries).toContain('SELECT 1');
    expect(queries[queries.length - 1]).toMatch(/^RELEASE SAVEPOINT /);
    expect(queries.some((q) => /^(BEGIN|COMMIT)$/.test(q))).toBe(false);
  });

  it('rolls back to the savepoint on error and rethrows, leaving the outer tx usable', async () => {
    await expect(
      als.run(fakeCtx(client), () =>
        withTransaction(async () => { throw new Error('boom'); }),
      ),
    ).rejects.toThrow('boom');
    expect(queries.some((q) => /^ROLLBACK TO SAVEPOINT /.test(q))).toBe(true);
    expect(queries.some((q) => q === 'ROLLBACK')).toBe(false);
  });

  it('logs the rollback on the request path too', async () => {
    const { log } = await import('@/lib/logger');
    vi.mocked(log.error).mockClear();
    await als.run(fakeCtx(client), () => withTransaction(async () => { throw new Error('boom'); })).catch(() => undefined);
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(expect.stringContaining('withTransaction rolled back'), expect.anything(), 'DB');
  });
});

describe('withTransaction — request tx in flight (integration)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('sees rows written earlier in the same request (FK parent visible)', async () => {
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      await als.run(fakeCtx(client), async () => {
        await sql`CREATE TEMP TABLE wt_parent (id INT PRIMARY KEY) ON COMMIT DROP`;
        await sql`CREATE TEMP TABLE wt_child (id INT PRIMARY KEY, parent_id INT REFERENCES wt_parent(id)) ON COMMIT DROP`;
        await sql`INSERT INTO wt_parent (id) VALUES (1)`; // uncommitted on the request client
        // Before the fix this ran on a second connection → 23503 (parent invisible).
        await withTransaction(async (tx) => { await tx`INSERT INTO wt_child (id, parent_id) VALUES (1, 1)`; });
        const rows = (await sql`SELECT COUNT(*)::INT AS n FROM wt_child`) as Array<{ n: number }>;
        expect(rows[0]?.n).toBe(1);
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
