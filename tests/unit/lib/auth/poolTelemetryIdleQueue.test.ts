/**
 * R-196: pg-pool queues EVERY connect() for one tick, even when an idle client is
 * ready (pulsed on nextTick). Saturation is a waiter that no idle client and no new
 * connection can serve: more waiters than idle clients plus the connections the pool
 * may still open.
 * In production R-188's check fired 628 times in a day with 1 of 10 connections open.
 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import pg from 'pg';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn() } }));

import { connectObserved, POOL_SATURATED_MESSAGE } from '@/lib/auth/poolTelemetry';

class FakeClient extends EventEmitter {
  // pg-pool keeps a released client idle only when it reports itself queryable.
  _queryable = true;
  _ending = false;
  connect(cb?: (err?: Error) => void) { if (cb) setImmediate(() => cb()); else return Promise.resolve(); }
  end(cb?: () => void) { cb?.(); return Promise.resolve(); }
  query() { return Promise.resolve({ rows: [] }); }
}
const realPool = (max: number) => new pg.Pool({ max, Client: FakeClient as unknown as typeof pg.Client });

describe('connectObserved: an idle client is not saturation (R-196)', () => {
  it('does not warn when an idle client serves the acquire (the production shape: 1 of 10 open, idle)', async () => {
    warn.mockReset();
    const pool = realPool(10);
    (await connectObserved(pool, 'idle-1')).release();
    expect(pool.idleCount).toBe(1);
    const c = await connectObserved(pool, 'idle-1');
    expect(warn).not.toHaveBeenCalled();
    c.release();
    await pool.end();
  });

  it('does not warn on a FULL pool while an idle client is still free', async () => {
    warn.mockReset();
    const pool = realPool(2);
    const a = await connectObserved(pool, 'full-idle');
    const b = await connectObserved(pool, 'full-idle');
    b.release();
    expect([pool.totalCount, pool.idleCount]).toEqual([2, 1]);
    const c = await connectObserved(pool, 'full-idle');
    expect(warn).not.toHaveBeenCalled();
    a.release(); c.release();
    await pool.end();
  });

  it('does not warn when a burst outnumbers the idle clients but the pool can still grow', async () => {
    warn.mockReset();
    const pool = realPool(10);
    (await connectObserved(pool, 'burst')).release();
    expect(pool.idleCount).toBe(1);
    const both = [connectObserved(pool, 'burst'), connectObserved(pool, 'burst')];
    expect(pool.waitingCount).toBe(2);
    expect(warn).not.toHaveBeenCalled();
    for (const c of await Promise.all(both)) c.release();
    await pool.end();
  });

  it('warns when a same-tick burst exceeds idle clients plus headroom on a pool that is not yet full', async () => {
    warn.mockReset();
    const pool = realPool(3);
    const a = await connectObserved(pool, 'burst-fill');
    const b = await connectObserved(pool, 'burst-fill');
    b.release();
    expect([pool.totalCount, pool.idleCount]).toEqual([2, 1]);
    const three = [connectObserved(pool, 'burst-fill'), connectObserved(pool, 'burst-fill'), connectObserved(pool, 'burst-fill')];
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toEqual({ pool: 'burst-fill', waitingCount: 3, totalCount: 2, idleCount: 1, max: 3 });
    const [c1, c2] = await Promise.all(three.slice(0, 2));
    a.release();
    (await three[2]!).release(); c1.release(); c2.release();
    await pool.end();
  });

  it('warns when the pool is full and the waiters outnumber the idle clients', async () => {
    warn.mockReset();
    const pool = realPool(2);
    const a = await connectObserved(pool, 'full-busy');
    const b = await connectObserved(pool, 'full-busy');
    const queued = connectObserved(pool, 'full-busy');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(POOL_SATURATED_MESSAGE);
    expect(warn.mock.calls[0]![1]).toEqual({ pool: 'full-busy', waitingCount: 1, totalCount: 2, idleCount: 0, max: 2 });
    a.release();
    (await queued).release(); b.release();
    await pool.end();
  });
});
