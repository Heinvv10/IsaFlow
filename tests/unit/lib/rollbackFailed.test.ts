/**
 * R-176 — rollbackFailed / rollbackError: the one place a transaction owner rolls back. It
 * reports a failure instead of throwing, logs it, never waits for a ROLLBACK longer than
 * rollbackBound.ms, and asks Postgres to cancel what the connection was running before the
 * owner destroys it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cancelBackend: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/cancelBackend', () => ({ cancelBackend: h.cancelBackend }));
import { log } from '@/lib/logger';
import { rollbackBound, rollbackError, rollbackFailed } from '@/lib/rollbackFailed';

const logged = () => vi.mocked(log.error).mock.calls;
const usual = rollbackBound.ms;

beforeEach(() => { vi.useFakeTimers(); vi.mocked(log.error).mockClear(); h.cancelBackend.mockReset(); });
afterEach(() => { vi.useRealTimers(); rollbackBound.ms = usual; });

describe('rollbackFailed', () => {
  it('a ROLLBACK that succeeds: false, one statement, nothing logged or cancelled, no timer left behind', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(rollbackFailed({ query }, 'owner')).resolves.toBe(false);
    expect(query.mock.calls).toEqual([['ROLLBACK']]);
    expect(logged()).toHaveLength(0);
    expect(h.cancelBackend).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a ROLLBACK that rejects: true, the owner and the error are logged, the backend is cancelled', async () => {
    const client = { query: vi.fn(async () => { throw new Error('connection reset'); }) };
    await expect(rollbackFailed(client, 'owner')).resolves.toBe(true);
    expect(logged()).toEqual([['owner: ROLLBACK failed, destroying the connection', { message: 'connection reset' }, 'DB']]);
    expect(h.cancelBackend.mock.calls).toEqual([[client]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rollbackError hands back the error itself, or null', async () => {
    const boom = new Error('connection reset');
    await expect(rollbackError({ query: async () => { throw boom; } }, 'owner')).resolves.toBe(boom);
    await expect(rollbackError({ query: async () => ({}) }, 'owner')).resolves.toBeNull();
  });

  it('a query() that throws instead of returning a promise: true, not thrown', async () => {
    const query = vi.fn(() => { throw new Error('client is closed'); });
    await expect(rollbackFailed({ query: query as never }, 'owner')).resolves.toBe(true);
    expect(logged()[0]![1]).toEqual({ message: 'client is closed' });
  });

  it('a ROLLBACK that never answers is abandoned at the bound, not before it, and the backend is cancelled', async () => {
    const client = { query: vi.fn(() => new Promise<never>(() => undefined)) };
    let settled: boolean | undefined;
    void rollbackFailed(client, 'owner').then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(usual - 1);
    expect(settled).toBeUndefined();
    expect(h.cancelBackend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(logged()[0]![1]).toEqual({ message: `ROLLBACK did not answer within ${usual}ms` });
    expect(h.cancelBackend.mock.calls).toEqual([[client]]);
  });

  it('the bound is read when the ROLLBACK is sent, so a test can shorten it', async () => {
    rollbackBound.ms = 40;
    let settled: boolean | undefined;
    void rollbackFailed({ query: () => new Promise<never>(() => undefined) }, 'owner').then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(39);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it('a cancel that throws does not escape: the owner still gets its answer', async () => {
    h.cancelBackend.mockImplementationOnce(() => { throw new Error('no route to host'); });
    await expect(rollbackFailed({ query: async () => { throw new Error('reset'); } }, 'owner')).resolves.toBe(true);
    expect(logged().map((c) => c[0])).toEqual(['owner: ROLLBACK failed, destroying the connection', 'owner: backend cancel failed']);
  });

  it('an abandoned ROLLBACK that rejects later is handled: no unhandled rejection, no second log line', async () => {
    let rejectLate: (err: Error) => void = () => undefined;
    const query = vi.fn(() => new Promise<never>((_, reject) => { rejectLate = reject; }));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const result = rollbackFailed({ query }, 'owner');
      await vi.advanceTimersByTimeAsync(usual);
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
