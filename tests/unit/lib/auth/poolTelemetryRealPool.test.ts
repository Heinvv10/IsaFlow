/**
 * R-188: against a REAL pg.Pool (a fake Client, so no database). pg-pool enqueues a
 * waiter synchronously inside connect(), so the FIRST waiter on a full pool is only
 * visible after connect() is called: a check before it sees an empty queue.
 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import pg from 'pg';

const { warn, error } = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn, error } }));

import { connectObserved, POOL_SATURATED_MESSAGE, POOL_ACQUIRE_FAILED_MESSAGE } from '@/lib/auth/poolTelemetry';

class FakeClient extends EventEmitter {
  // R-196: without these pg-pool discards a released client, so no test here ever had an idle one.
  _queryable = true;
  _ending = false;
  connect(cb?: (err?: Error) => void) { if (cb) setImmediate(() => cb()); else return Promise.resolve(); }
  end(cb?: () => void) { cb?.(); return Promise.resolve(); }
  query() { return Promise.resolve({ rows: [] }); }
}
const realPool = (max: number, extra: Partial<pg.PoolConfig> = {}) =>
  new pg.Pool({ max, Client: FakeClient as unknown as typeof pg.Client, ...extra });

describe('connectObserved against a real pg.Pool (R-188)', () => {
  it('warns for the FIRST queued acquire on a full pool, with the counts', async () => {
    warn.mockReset();
    const pool = realPool(1);
    const held = await connectObserved(pool, 'real');
    expect(warn).not.toHaveBeenCalled();

    const queued = connectObserved(pool, 'real');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(POOL_SATURATED_MESSAGE);
    expect(warn.mock.calls[0]![1]).toEqual({ pool: 'real', waitingCount: 1, totalCount: 1, idleCount: 0, max: 1 });

    held.release();
    (await queued).release();
    await pool.end();
  });

  it('does not warn when a connection is free', async () => {
    warn.mockReset();
    const pool = realPool(2);
    (await connectObserved(pool, 'free')).release();
    expect(pool.idleCount).toBe(1);
    (await connectObserved(pool, 'free')).release();
    expect(warn).not.toHaveBeenCalled();
    await pool.end();
  });

  it('logs the counts as they were at acquire time when the queued acquire times out', async () => {
    error.mockReset();
    const pool = realPool(1, { connectionTimeoutMillis: 30 });
    const held = await connectObserved(pool, 'slow');
    await expect(connectObserved(pool, 'slow')).rejects.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toBe(POOL_ACQUIRE_FAILED_MESSAGE);
    expect(error.mock.calls[0]![1]).toMatchObject({ pool: 'slow', waitingCount: 1, totalCount: 1, max: 1 });
    held.release();
    await pool.end();
  });

  it('a synchronous throw from connect() takes the same error path', async () => {
    error.mockReset();
    const pool = { waitingCount: 0, totalCount: 0, idleCount: 0, options: { max: 1 }, connect: () => { throw new Error('sync boom'); } };
    await expect(connectObserved(pool as never, 'sync')).rejects.toThrow('sync boom');
    expect(error).toHaveBeenCalledTimes(1);
  });
});
