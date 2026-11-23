/** R2 (round 4): one Sage migration per company at a time. */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { EventEmitter } from 'node:events';
import { acquireRunLock, CHECK_TIMEOUT_MS, KEEPALIVE_MS, LockLostError, migrationLockKey, RunInProgressError } from '@/modules/accounting/services/sage-migration/sageRunLock';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function fakePool(over: { ok?: boolean; unlockFails?: boolean; lockThrows?: boolean; checkFails?: boolean } = {}) {
  const calls: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (text: string) => {
      calls.push(text.includes('pg_try_advisory_lock') ? 'lock' : text.includes('idle_session_timeout') ? text.split(' ')[0]!.toLowerCase() : text.includes('SELECT 1') ? 'check' : 'unlock');
      if (text.includes('pg_try_advisory_lock')) { if (over.lockThrows) throw new Error('lock query failed'); return { rows: [{ ok: over.ok ?? true }] }; }
      if (text.includes('SELECT 1') && over.checkFails) throw new Error('Connection terminated');
      if (over.unlockFails && text.includes('unlock')) throw new Error('unlock failed');
      return { rows: [{}] };
    }),
    release: vi.fn(),
  });
  return { pool: { connect: vi.fn(async () => client) } as never, client, calls };
}

describe('migrationLockKey', () => {
  it('L1 (round 9): an id with hex LETTERS gives the same key in upper and lower case (the digit-only ids above cannot tell)', () => {
    const lower = 'abcdef12-3456-4abc-8def-0123456789ab';
    expect(migrationLockKey(lower.toUpperCase())).toEqual(migrationLockKey(lower));
    expect(migrationLockKey(lower)).not.toEqual(migrationLockKey('abcdef12-3456-4abc-8def-0123456789ac'));
  });
  it('is two int4 keys, the same for a company however its id is cased, and different for another company', () => {
    const [a1, a2] = migrationLockKey(A);
    expect(Number.isInteger(a1) && Number.isInteger(a2) && Math.abs(a1) < 2 ** 31 && Math.abs(a2) < 2 ** 31).toBe(true);
    expect(migrationLockKey(A.toUpperCase())).toEqual([a1, a2]);
    expect(migrationLockKey(B)[1]).not.toBe(a2);
    expect(migrationLockKey(B)[0]).toBe(a1); // the first key names the feature
  });
});

vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

describe('acquireRunLock', () => {
  it('takes the lock on a connection of its own, and the release function unlocks and returns the connection', async () => {
    const { pool, client, calls } = fakePool();
    const { unlock: release } = await acquireRunLock(pool, A);
    expect(calls).toEqual(['lock', 'set']);
    expect(client.release).not.toHaveBeenCalled(); // held for the whole run
    await release();
    expect(calls).toEqual(['lock', 'set', 'unlock', 'reset']);
    expect(client.release).toHaveBeenCalledWith(undefined); // returned to the pool, not destroyed
  });
  it('a lock someone else holds is RunInProgressError, naming the company, and the connection goes back', async () => {
    const { pool, client } = fakePool({ ok: false });
    await expect(acquireRunLock(pool, A)).rejects.toThrow(RunInProgressError);
    await expect(acquireRunLock(pool, A)).rejects.toThrow(/another Sage migration is running for this company \(11111111/);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });
  it('a failed lock query destroys the connection and throws that error', async () => {
    const { pool, client } = fakePool({ lockThrows: true });
    await expect(acquireRunLock(pool, A)).rejects.toThrow('lock query failed');
    expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ message: 'lock query failed' }));
  });
  it('an unlock that fails destroys the connection (which drops the lock) instead of pooling it with the lock on', async () => {
    const { pool, client } = fakePool({ unlockFails: true });
    const { unlock: release } = await acquireRunLock(pool, A);
    await release();
    expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ message: 'unlock failed' }));
  });
});

describe('the lock connection is watched (M2, round 5)', () => {
  it('an error event on the idle lock connection is recorded, not thrown into the process; the next check says the lock is lost', async () => {
    const { pool, client } = fakePool();
    const { check } = await acquireRunLock(pool, A);
    await expect(check()).resolves.toBeUndefined();
    expect(() => client.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow(); // an EventEmitter with no listener throws
    await expect(check()).rejects.toThrow(LockLostError);
    await expect(check()).rejects.toThrow(/lock lost.*terminating connection/s);
  });
  it('B6-B (round 6): held() answers from what the error event recorded, without a query (cheap before every batch)', async () => {
    const { pool, client } = fakePool();
    const { held } = await acquireRunLock(pool, A);
    const before = client.query.mock.calls.length;
    expect(() => held()).not.toThrow();
    client.emit('error', new Error('terminating connection due to administrator command'));
    expect(() => held()).toThrow(LockLostError);
    expect(() => held()).toThrow(/lock lost.*terminating connection/s);
    expect(client.query.mock.calls.length).toBe(before); // no query
  });
  it('a connection whose probe query fails is a lost lock too', async () => {
    const { pool } = fakePool({ checkFails: true });
    const { check } = await acquireRunLock(pool, A);
    await expect(check()).rejects.toThrow(/lock lost.*Connection terminated/s);
  });
  it('the listener is removed when the lock is released (the connection goes back to the pool clean)', async () => {
    const { pool, client } = fakePool();
    const { unlock: release } = await acquireRunLock(pool, A);
    expect(client.listenerCount('error')).toBe(1);
    await release();
    expect(client.listenerCount('error')).toBe(0);
  });
  it('a failed lock attempt leaves no listener behind either', async () => {
    const { pool, client } = fakePool({ ok: false });
    await acquireRunLock(pool, A).catch(() => null);
    expect(client.listenerCount('error')).toBe(0);
  });
});

describe('the lock connection is kept from idling out (round 5, B5-B2)', () => {
  it('sets idle_session_timeout to 0 on the lock session once it holds the lock, and resets it when the lock is given up', async () => {
    const { pool, calls } = fakePool();
    const { unlock } = await acquireRunLock(pool, A);
    expect(calls).toEqual(['lock', 'set']);
    await unlock();
    expect(calls).toEqual(['lock', 'set', 'unlock', 'reset']);
  });
  it('a refused lock sets nothing on the connection it hands back', async () => {
    const { pool, calls } = fakePool({ ok: false });
    await acquireRunLock(pool, A).catch(() => null);
    expect(calls).toEqual(['lock']);
  });
  it('pings the connection while the lock is held, and not after it is given up', async () => {
    vi.useFakeTimers();
    try {
      const { pool, calls } = fakePool();
      const { unlock } = await acquireRunLock(pool, A);
      await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 3 + 10);
      expect(calls.filter((c) => c === 'check')).toHaveLength(3);
      await unlock();
      const n = calls.length;
      await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 3);
      expect(calls).toHaveLength(n);
    } finally { vi.useRealTimers(); }
  });
  it('a failed ping is a lost lock', async () => {
    vi.useFakeTimers();
    try {
      const { pool } = fakePool({ checkFails: true });
      const { check } = await acquireRunLock(pool, A);
      await vi.advanceTimersByTimeAsync(KEEPALIVE_MS + 10);
      await expect(check()).rejects.toThrow(/lock lost/);
    } finally { vi.useRealTimers(); }
  });
});

describe('a half-open lock connection does not hang the run (round 6 L3)', () => {
  it('a probe that never answers is a lost lock after CHECK_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    try {
      const { pool, client } = fakePool();
      const { check } = await acquireRunLock(pool, A);
      client.query.mockImplementation(() => new Promise(() => undefined)); // the network has gone: no answer, no error
      const outcome = check().then(() => 'ok', (e: Error) => e);
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS + 10);
      const e = await outcome;
      expect(e).toBeInstanceOf(LockLostError);
      expect((e as Error).message).toMatch(/lock lost.*no answer within/);
    } finally { vi.useRealTimers(); }
  });
  it('a probe that answers in time clears its timer (no timer is left behind)', async () => {
    vi.useFakeTimers();
    try {
      const { pool } = fakePool();
      const { check, unlock } = await acquireRunLock(pool, A);
      await check();
      await unlock();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('unlock says when the lock was not held (round 6 L4)', () => {
  it('pg_advisory_unlock answering false is logged', async () => {
    const { pool, client } = fakePool();
    const { unlock } = await acquireRunLock(pool, A);
    const orig = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (text: string) => (text.includes('pg_advisory_unlock') ? { rows: [{ ok: false }] } : orig(text)));
    await unlock();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/run lock was not held/), expect.anything(), 'sage-migration');
  });
});

describe('unlock cannot hang the run on a dead connection (round 7 L2)', () => {
  it('an unlock that never answers gives up after CHECK_TIMEOUT_MS and destroys the connection (release with an error)', async () => {
    vi.useFakeTimers();
    try {
      const { pool, client } = fakePool();
      const { unlock } = await acquireRunLock(pool, A);
      client.query.mockImplementation(() => new Promise(() => undefined)); // half-open: no answer, no error
      const done = unlock().then(() => 'done');
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS + 10);
      await expect(done).resolves.toBe('done');
      expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/no answer within/) }));
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
