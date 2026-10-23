/**
 * Savepoints on one request connection must nest LIFO. `Promise.all` of two
 * reads that each run in a savepoint (the fiscal-year registry's reads do)
 * interleaved them: SAVEPOINT a, SAVEPOINT b, RELEASE a (which also releases
 * b), RELEASE b → "savepoint b does not exist" and an aborted request (the
 * budgets page's 500, PR #813). `withSavepoint` now queues siblings on the same
 * connection; a savepoint opened inside another one queues only behind its own
 * siblings, so nesting never waits on its parent.
 *
 * The fake client below enforces Postgres's savepoint rules (RELEASE of a name
 * releases everything opened after it; an unknown name is an error), and every
 * query yields to the event loop so concurrent callers really interleave.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { withSavepoint, sql } from '@/lib/neon';
import { als } from '@/lib/als';

function pgLikeClient() {
  const stack: string[] = [];
  const log: string[] = [];
  const query = vi.fn(async (text: string) => {
    await new Promise((r) => setTimeout(r, 0));
    log.push(text);
    const m = /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) (\w+)$/.exec(text);
    if (m) {
      const [, verb, name] = m;
      if (verb === 'SAVEPOINT') { stack.push(name!); return { rows: [] }; }
      const at = stack.lastIndexOf(name!);
      if (at < 0) throw new Error(`savepoint "${name}" does not exist`);
      stack.length = verb === 'RELEASE SAVEPOINT' ? at : at + 1;
      return { rows: [] };
    }
    if (text.includes('FAIL')) throw new Error('boom');
    return { rows: [{ ok: 1 }] };
  });
  return { client: { query }, stack, log };
}

function inRequest<T>(client: { query: unknown }, fn: () => Promise<T>): Promise<T> {
  return als.run({ client, userId: 'u1', companyId: 'c1', claims: {} } as never, fn);
}

const read = (n: number) => async () => { await sql`SELECT ${n}`; await sql`SELECT ${n}`; return n; };

describe('withSavepoint on one request connection', () => {
  it('two concurrent savepoints both succeed and never interleave', async () => {
    const pg = pgLikeClient();
    const out = await inRequest(pg.client, () => Promise.all([withSavepoint('sp_a', read(1)), withSavepoint('sp_b', read(2))]));
    expect(out).toEqual([1, 2]);
    expect(pg.stack).toEqual([]);
    const marks = pg.log.filter((t) => /SAVEPOINT/.test(t));
    expect(marks).toEqual(['SAVEPOINT sp_a', 'RELEASE SAVEPOINT sp_a', 'SAVEPOINT sp_b', 'RELEASE SAVEPOINT sp_b']);
  });

  it('a savepoint inside another runs at once (no wait on its parent), and nested siblings queue among themselves', async () => {
    const pg = pgLikeClient();
    const out = await inRequest(pg.client, () => withSavepoint('outer', async () => {
      const inner = await withSavepoint('inner', read(3));
      const pair = await Promise.all([withSavepoint('kid_a', read(4)), withSavepoint('kid_b', read(5))]);
      return [inner, ...pair];
    }));
    expect(out).toEqual([3, 4, 5]);
    expect(pg.log.filter((t) => /SAVEPOINT/.test(t))).toEqual([
      'SAVEPOINT outer', 'SAVEPOINT inner', 'RELEASE SAVEPOINT inner',
      'SAVEPOINT kid_a', 'RELEASE SAVEPOINT kid_a', 'SAVEPOINT kid_b', 'RELEASE SAVEPOINT kid_b',
      'RELEASE SAVEPOINT outer',
    ]);
  });

  it('a sibling that fails rolls back alone; the other still commits its work', async () => {
    const pg = pgLikeClient();
    const results = await inRequest(pg.client, () => Promise.allSettled([
      withSavepoint('sp_bad', async () => { await sql`SELECT 1`; await sql`SELECT FAIL`; }),
      withSavepoint('sp_ok', read(7)),
    ]));
    expect(results[0]!.status).toBe('rejected');
    expect(results[1]).toEqual({ status: 'fulfilled', value: 7 });
    expect(pg.stack).toEqual([]);
  });

  it('separate requests (separate connections) do not wait on each other', async () => {
    const a = pgLikeClient();
    const b = pgLikeClient();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = inRequest(a.client, () => withSavepoint('sp_slow', async () => { await gate; return 'a'; }));
    const fast = await inRequest(b.client, () => withSavepoint('sp_fast', read(9)));
    expect(fast).toBe(9);
    release();
    expect(await slow).toBe('a');
  });
});
