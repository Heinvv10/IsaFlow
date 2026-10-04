/**
 * R-188: the signal for the AUTH_POOL_MAX rollback. An acquire that has to queue
 * logs a rate-limited warning with the pool's counts; an acquire that times out
 * logs an error naming the pool and rethrows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { warn, error } = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn, error } }));

import { connectObserved, POOL_WARN_INTERVAL_MS, POOL_SATURATED_MESSAGE, POOL_ACQUIRE_FAILED_MESSAGE } from '@/lib/auth/poolTelemetry';

function fakePool(over: Partial<{ waitingCount: number; connect: () => Promise<unknown> }> = {}) {
  return { waitingCount: 0, totalCount: 10, idleCount: 0, options: { max: 10 }, connect: vi.fn(async () => ({ id: 'client' })), ...over };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T10:00:00Z')); warn.mockReset(); error.mockReset(); });
afterEach(() => vi.useRealTimers());

describe('connectObserved (R-188)', () => {
  it('returns the client and logs nothing when nobody is waiting', async () => {
    const p = fakePool();
    await expect(connectObserved(p as never, 'quiet')).resolves.toEqual({ id: 'client' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns with the pool counts when an acquire has to queue', async () => {
    const p = fakePool({ waitingCount: 3 });
    await connectObserved(p as never, 'authPool');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(POOL_SATURATED_MESSAGE);
    expect(warn.mock.calls[0]![1]).toEqual({ pool: 'authPool', waitingCount: 3, totalCount: 10, idleCount: 0, max: 10 });
  });

  it('warns at most once per interval per pool, and again after it', async () => {
    const p = fakePool({ waitingCount: 1 });
    for (let i = 0; i < 5; i++) await connectObserved(p as never, 'rate');
    expect(warn).toHaveBeenCalledTimes(1);
    await connectObserved(p as never, 'rate-other');
    expect(warn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(POOL_WARN_INTERVAL_MS);
    await connectObserved(p as never, 'rate');
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('logs an error naming the pool when the acquire fails, and rethrows', async () => {
    const boom = new Error('timeout exceeded when trying to connect');
    const p = fakePool({ connect: async () => { throw boom; } });
    await expect(connectObserved(p as never, 'bearerPipeline')).rejects.toBe(boom);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toBe(POOL_ACQUIRE_FAILED_MESSAGE);
    expect(error.mock.calls[0]![1]).toMatchObject({ pool: 'bearerPipeline', waitingCount: 0, max: 10, message: boom.message });
  });
});
