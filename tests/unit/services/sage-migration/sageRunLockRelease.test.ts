/**
 * B38-2 (round 38): the run lock's connection goes back to the pool through one guarded release. A release that throws (a pool wrapper)
 * never replaces what the lock decided (the lock taken, RunInProgressError, RunLockNotTakenError, an unlock's warning): it is logged, the
 * connection is released again with that failure (truthy: pg destroys it), and unlock() says it as not confirmed.
 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { acquireRunLock, RunInProgressError, RunLockNotTakenError } from '@/modules/accounting/services/sage-migration/sageRunLock';

vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const A = '11111111-1111-4111-8111-111111111111';
/** pg-pool destroys a client released with a truthy argument (an Error here: the release's own failure). */
const destroys = (arg: unknown): boolean => arg instanceof Error && /injected: hostile run-lock release/.test(arg.message);

/** A pool whose client's release throws on its first call (`after`: having released first), or on every call (`always`). */
function hostilePool(over: { ok?: boolean; setFails?: boolean; mode: 'first' | 'always' }) {
  let n = 0;
  const client = Object.assign(new EventEmitter(), {
    processID: 5150,
    query: vi.fn(async (text: string) => {
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ ok: over.ok ?? true }] };
      if (text.startsWith('SET idle_session_timeout') && over.setFails) throw new Error('SET refused');
      return { rows: [{ ok: true }] };
    }),
    release: vi.fn(() => { if (over.mode === 'always' || n++ === 0) throw new Error('injected: hostile run-lock release'); }),
  });
  return { pool: { connect: vi.fn(async () => client) } as never, client };
}

describe('B38-2: a run lock release that throws', () => {
  for (const mode of ['first', 'always'] as const) {
    it(`(${mode}) at unlock: unlock() resolves with a warning, the connection released again with its failure (destroyed)`, async () => {
      const { pool, client } = hostilePool({ mode });
      const lock = await acquireRunLock(pool, A);
      const warning = await lock.unlock();
      expect(warning).toMatch(/^its run lock release was not confirmed \(injected: hostile run-lock release\); backend pid 5150/);
      expect(client.release).toHaveBeenCalledTimes(2);
      expect(client.release.mock.calls[0]).toEqual([undefined]);
      expect(destroys(client.release.mock.calls[1]![0])).toBe(true);
      expect(client.listenerCount('error')).toBe(0);
    });
    it(`(${mode}) when someone else holds the lock: still RunInProgressError`, async () => {
      const { pool, client } = hostilePool({ ok: false, mode });
      await expect(acquireRunLock(pool, A)).rejects.toThrow(RunInProgressError);
      expect(client.release).toHaveBeenCalledTimes(2);
      expect(client.release.mock.calls[0]).toEqual([undefined]);
      expect(destroys(client.release.mock.calls[1]![0])).toBe(true);
    });
    it(`(${mode}) when the session setting fails: still RunLockNotTakenError`, async () => {
      const { pool, client } = hostilePool({ setFails: true, mode });
      await expect(acquireRunLock(pool, A)).rejects.toThrow(RunLockNotTakenError);
      expect(client.release).toHaveBeenCalledTimes(2);
      expect(destroys(client.release.mock.calls[1]![0])).toBe(true);
    });
  }
});
