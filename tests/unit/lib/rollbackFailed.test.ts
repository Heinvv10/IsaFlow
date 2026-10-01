/**
 * R-176 — rollbackFailed: the one place a transaction owner rolls back. It reports a failure
 * instead of throwing, logs it, and never waits for a ROLLBACK longer than ROLLBACK_TIMEOUT_MS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
import { log } from '@/lib/logger';
import { ROLLBACK_TIMEOUT_MS, rollbackFailed } from '@/lib/rollbackFailed';

const logged = () => vi.mocked(log.error).mock.calls;

beforeEach(() => { vi.useFakeTimers(); vi.mocked(log.error).mockClear(); });
afterEach(() => { vi.useRealTimers(); });

describe('rollbackFailed', () => {
  it('a ROLLBACK that succeeds: false, one statement, nothing logged, no timer left behind', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(rollbackFailed({ query }, 'owner')).resolves.toBe(false);
    expect(query.mock.calls).toEqual([['ROLLBACK']]);
    expect(logged()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a ROLLBACK that rejects: true, and the owner and the error are logged', async () => {
    const query = vi.fn(async () => { throw new Error('connection reset'); });
    await expect(rollbackFailed({ query }, 'owner')).resolves.toBe(true);
    expect(logged()).toEqual([['owner: ROLLBACK failed, destroying the connection', { message: 'connection reset' }, 'DB']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a query() that throws instead of returning a promise: true, not thrown', async () => {
    const query = vi.fn(() => { throw new Error('client is closed'); });
    await expect(rollbackFailed({ query: query as never }, 'owner')).resolves.toBe(true);
    expect(logged()[0]![1]).toEqual({ message: 'client is closed' });
  });

  it('a ROLLBACK that never answers is abandoned at the bound, not before it', async () => {
    const query = vi.fn(() => new Promise<never>(() => undefined));
    let settled: boolean | undefined;
    void rollbackFailed({ query }, 'owner').then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(ROLLBACK_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(logged()[0]![1]).toEqual({ message: `ROLLBACK did not answer within ${ROLLBACK_TIMEOUT_MS}ms` });
  });

  it('the bound is a few seconds', () => {
    expect(ROLLBACK_TIMEOUT_MS).toBe(5000);
  });

  it('an abandoned ROLLBACK that rejects later is handled: no unhandled rejection, no second log line', async () => {
    let rejectLate: (err: Error) => void = () => undefined;
    const query = vi.fn(() => new Promise<never>((_, reject) => { rejectLate = reject; }));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const result = rollbackFailed({ query }, 'owner');
      await vi.advanceTimersByTimeAsync(ROLLBACK_TIMEOUT_MS);
      await expect(result).resolves.toBe(true);
      rejectLate(new Error('Connection terminated'));
      vi.useRealTimers();
      await new Promise((done) => setTimeout(done, 20)); // let Node report an unhandled rejection, if any
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
    expect(logged()).toHaveLength(1);
  });
});
