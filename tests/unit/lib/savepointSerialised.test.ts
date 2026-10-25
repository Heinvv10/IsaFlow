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

import { withSavepoint, sql, SavepointQueueTimeoutError, savepointQueueWait } from '@/lib/neon';
import { als } from '@/lib/als';

function pgLikeClient(delayMs = 0) {
  const stack: string[] = [];
  const log: string[] = [];
  const query = vi.fn(async (text: string) => {
    await new Promise((r) => setTimeout(r, delayMs));
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

  it('a plain sibling write never lands inside a sibling savepoint that rolls back', async () => {
    const pg = pgLikeClient();
    await inRequest(pg.client, () => Promise.allSettled([
      withSavepoint('sp_bad', async () => { await sql`SELECT 1`; await sql`SELECT 2`; await sql`SELECT FAIL`; }),
      (async () => { await sql`INSERT plain_write`; })(),
    ]));
    const at = pg.log.indexOf('INSERT plain_write');
    expect(at).toBeGreaterThan(pg.log.indexOf('ROLLBACK TO SAVEPOINT sp_bad'));
  });

  // These run on fake timers (Date is faked too): with real timers a 60 ms setTimeout stretched past the
  // 100 ms bound by event-loop jitter on a busy box, and a broken bound hung for the full test timeout.
  describe('progress-based bound (fake clock)', () => {
    const bound = async (fn: () => Promise<void>) => {
      const saved = savepointQueueWait.ms;
      savepointQueueWait.ms = 100;
      vi.useFakeTimers();
      try { await fn(); } finally { vi.useRealTimers(); savepointQueueWait.ms = saved; }
    };
    const sleeper = (name: string, ms: number) =>
      withSavepoint(name, async () => { await new Promise((r) => setTimeout(r, ms)); return name; });

    it('a savepoint whose sibling awaits it fails loudly after the bound instead of hanging', () => bound(async () => {
      const pg = pgLikeClient();
      const run = inRequest(pg.client, async () => {
        // Started outside `work`, so its savepoint queues behind `work`, which awaits it.
        const lookup = (async () => { await sql`SELECT 1`; return withSavepoint('lookup', () => sql`SELECT 2`); })();
        lookup.catch(() => undefined);
        return withSavepoint('work', async () => { await lookup; return 'ok'; }).catch((e: unknown) => e);
      });
      let settled = false;
      void run.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(400);
      expect(settled, 'the bound must have refused the waiter by now').toBe(true); // fails fast instead of hanging
      expect(await run).toBeInstanceOf(SavepointQueueTimeoutError);
    }));

    it('a waiter behind siblings that keep finishing is not refused, however long it waits in total', () => bound(async () => {
      const pg = pgLikeClient();
      // The last one waits 180 ms in total, but something finishes every 60 ms.
      const run = inRequest(pg.client, () => Promise.all([sleeper('s1', 60), sleeper('s2', 60), sleeper('s3', 60), withSavepoint('last', read(1))]));
      await vi.advanceTimersByTimeAsync(400);
      expect(await run).toEqual(['s1', 's2', 's3', 1]);
    }));

    it('a waiter behind a sibling that makes no progress for the bound IS refused', () => bound(async () => {
      const pg = pgLikeClient();
      const run = inRequest(pg.client, () => Promise.all([sleeper('stuck', 150), withSavepoint('waiter', read(1))].map((p) => p.catch((e: unknown) => e))));
      let settled = false;
      void run.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(400);
      expect(settled, 'the bound must have refused the waiter by now').toBe(true);
      const [stuck, waiter] = await run;
      expect(stuck).toBe('stuck');
      expect(waiter).toBeInstanceOf(SavepointQueueTimeoutError);
    }));

    it('a waiter behind ONE long savepoint that keeps completing statements is not refused', () => bound(async () => {
      const pg = pgLikeClient(40);
      // 240+ ms inside one savepoint, but a statement completes every 40 ms.
      const busy = () => withSavepoint('busy', async () => { for (let i = 0; i < 6; i += 1) await sql`SELECT ${i}`; return 'busy'; });
      const run = inRequest(pg.client, () => Promise.all([busy(), sql`SELECT after`.then(() => 'after')]));
      await vi.advanceTimersByTimeAsync(1000);
      expect(await run).toEqual(['busy', 'after']);
    }));
  });

  it('a sql.transaction batch queues with sibling savepoints instead of interleaving', async () => {
    const pg = pgLikeClient();
    const out = await inRequest(pg.client, () => Promise.all([
      withSavepoint('sp_a', read(1)),
      sql.transaction([sql`SELECT 10`, sql`SELECT 11`]).then((r) => r.length),
    ]));
    expect(out).toEqual([1, 2]);
    expect(pg.stack).toEqual([]);
    const marks = pg.log.filter((t) => /SAVEPOINT/.test(t)).map((t) => t.replace(/sp_sqltx_\d+/, 'sp_sqltx'));
    expect(marks).toEqual(['SAVEPOINT sp_a', 'RELEASE SAVEPOINT sp_a', 'SAVEPOINT sp_sqltx', 'RELEASE SAVEPOINT sp_sqltx']);
  });

  it('a failed sql.transaction batch rolls back AND releases its savepoint (no open subtransaction is left)', async () => {
    const pg = pgLikeClient();
    const results = await inRequest(pg.client, () => Promise.allSettled([
      sql.transaction([sql`SELECT ok`, sql`SELECT FAIL`]),
      withSavepoint('after', read(3)),
    ]));
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(pg.stack).toEqual([]);
  });
});

