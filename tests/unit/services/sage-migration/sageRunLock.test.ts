/** R2 (round 4): one Sage migration per company at a time. */
import { describe, expect, it, vi } from 'vitest';
import { acquireRunLock, migrationLockKey, RunInProgressError } from '@/modules/accounting/services/sage-migration/sageRunLock';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function fakePool(over: { ok?: boolean; unlockFails?: boolean; lockThrows?: boolean } = {}) {
  const calls: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      calls.push(text.includes('pg_try_advisory_lock') ? 'lock' : 'unlock');
      if (text.includes('pg_try_advisory_lock')) { if (over.lockThrows) throw new Error('lock query failed'); return { rows: [{ ok: over.ok ?? true }] }; }
      if (over.unlockFails) throw new Error('unlock failed');
      return { rows: [{}] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) } as never, client, calls };
}

describe('migrationLockKey', () => {
  it('is two int4 keys, the same for a company however its id is cased, and different for another company', () => {
    const [a1, a2] = migrationLockKey(A);
    expect(Number.isInteger(a1) && Number.isInteger(a2) && Math.abs(a1) < 2 ** 31 && Math.abs(a2) < 2 ** 31).toBe(true);
    expect(migrationLockKey(A.toUpperCase())).toEqual([a1, a2]);
    expect(migrationLockKey(B)[1]).not.toBe(a2);
    expect(migrationLockKey(B)[0]).toBe(a1); // the first key names the feature
  });
});

describe('acquireRunLock', () => {
  it('takes the lock on a connection of its own, and the release function unlocks and returns the connection', async () => {
    const { pool, client, calls } = fakePool();
    const release = await acquireRunLock(pool, A);
    expect(calls).toEqual(['lock']);
    expect(client.release).not.toHaveBeenCalled(); // held for the whole run
    await release();
    expect(calls).toEqual(['lock', 'unlock']);
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
    const release = await acquireRunLock(pool, A);
    await release();
    expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ message: 'unlock failed' }));
  });
});
