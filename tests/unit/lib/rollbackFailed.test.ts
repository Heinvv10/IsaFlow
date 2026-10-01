/**
 * R-176 — rollbackFailed / rollbackError: the one place a transaction owner rolls back. It
 * reports a failure instead of throwing, logs it, never waits for a ROLLBACK longer than
 * ROLLBACK_TIMEOUT_MS, and asks Postgres to cancel what the connection was running before the
 * owner destroys it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cancelBackend: vi.fn(() => true) }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/cancelBackend', () => ({ cancelBackend: h.cancelBackend }));
import { log } from '@/lib/logger';
import { ROLLBACK_TIMEOUT_MS, rollbackError, rollbackFailed, setRollbackBoundForTests } from '@/lib/rollbackFailed';

const logged = () => vi.mocked(log.error).mock.calls;
const usual = ROLLBACK_TIMEOUT_MS;
let restore = () => undefined as void;

beforeEach(() => { vi.useFakeTimers(); vi.mocked(log.error).mockClear(); h.cancelBackend.mockReset(); h.cancelBackend.mockReturnValue(true); });
afterEach(() => { vi.useRealTimers(); restore(); restore = () => undefined; vi.unstubAllEnvs(); });

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

  it('a test can shorten the bound, and gets a restore', async () => {
    restore = setRollbackBoundForTests(40);
    let settled: boolean | undefined;
    void rollbackFailed({ query: () => new Promise<never>(() => undefined) }, 'owner').then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(39);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    restore();
    let again: boolean | undefined;
    void rollbackFailed({ query: () => new Promise<never>(() => undefined) }, 'owner').then((v) => { again = v; });
    await vi.advanceTimersByTimeAsync(usual - 1);
    expect(again).toBeUndefined(); // back to the production bound
    await vi.advanceTimersByTimeAsync(1);
    expect(again).toBe(true);
  });

  it.each(['production', 'development', ''])('outside a test run (NODE_ENV=%j) the bound cannot be changed', async (env) => {
    vi.stubEnv('NODE_ENV', env);
    expect(() => setRollbackBoundForTests(0)).toThrow(/only in a test run/);
    let settled: boolean | undefined;
    void rollbackFailed({ query: () => new Promise<never>(() => undefined) }, 'owner').then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(usual - 1);
    expect(settled).toBeUndefined(); // still the production bound
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it('the production bound is exported read-only', async () => {
    const mod = await import('@/lib/rollbackFailed');
    expect(Object.keys(mod).sort()).toEqual(['ROLLBACK_TIMEOUT_MS', 'rollbackError', 'rollbackFailed', 'setRollbackBoundForTests']);
    expect(() => { (mod as { ROLLBACK_TIMEOUT_MS: number }).ROLLBACK_TIMEOUT_MS = 1; }).toThrow();
  });

  it('a ROLLBACK that timed out (no answer, or pg\'s query_timeout) with no cancel possible is warned once; a refused one is not', async () => {
    // A fresh module, so "once per process" starts from nothing said.
    vi.resetModules();
    const fresh = await import('@/lib/rollbackFailed');
    const freshLog = (await import('@/lib/logger')).log;
    const cannot = () => vi.mocked(freshLog.warn).mock.calls.filter((c) => String(c[0]).includes('cannot cancel')).length;
    h.cancelBackend.mockReturnValue(false);
    // Refused outright: nothing is known to be in flight, so there is nothing to warn about.
    await fresh.rollbackFailed({ query: async () => { throw new Error('reset'); } }, 'owner');
    expect(cannot()).toBe(0);
    // Refused by node-postgres's own query_timeout: a statement is still in flight.
    await fresh.rollbackFailed({ query: async () => { throw new Error('Query read timeout'); } }, 'owner');
    expect(cannot()).toBe(1);
    await fresh.rollbackFailed({ query: async () => { throw new Error('Query read timeout'); } }, 'owner');
    expect(cannot()).toBe(1); // once per process
    // A ROLLBACK that never answered, in a process that has not warned yet.
    vi.resetModules();
    const third = await import('@/lib/rollbackFailed');
    const thirdLog = (await import('@/lib/logger')).log;
    const thirdCannot = () => vi.mocked(thirdLog.warn).mock.calls.filter((c) => String(c[0]).includes('cannot cancel')).length;
    const before = thirdCannot();
    for (let i = 0; i < 2; i += 1) {
      const pending = third.rollbackFailed({ query: () => new Promise<never>(() => undefined) }, 'owner');
      await vi.advanceTimersByTimeAsync(usual);
      await expect(pending).resolves.toBe(true);
    }
    expect(thirdCannot() - before).toBe(1);
    // And not at all when the cancel could be sent.
    vi.resetModules();
    const again = await import('@/lib/rollbackFailed');
    const againLog = (await import('@/lib/logger')).log;
    const saidBefore = vi.mocked(againLog.warn).mock.calls.length;
    h.cancelBackend.mockReturnValue(true);
    const result = again.rollbackFailed({ query: () => new Promise<never>(() => undefined) }, 'owner');
    await vi.advanceTimersByTimeAsync(usual);
    await expect(result).resolves.toBe(true);
    expect(vi.mocked(againLog.warn).mock.calls.length).toBe(saidBefore);
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
