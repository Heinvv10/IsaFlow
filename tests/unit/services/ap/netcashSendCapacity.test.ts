/**
 * AP-01 round 11: the in-process cap on Netcash sends in flight and the bounded claim-connection checkout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import { connectWithin, maxConcurrentSends, takeSendSlot } from '@/modules/accounting/services/ap/netcashSendCapacity';

afterEach(() => { delete process.env.NETCASH_MAX_CONCURRENT_SENDS; vi.useRealTimers(); });

describe('takeSendSlot', () => {
  it('admits the default 3, refuses the 4th, and a slot released twice frees one place only', () => {
    expect(maxConcurrentSends()).toBe(3);
    const slots = [takeSendSlot(), takeSendSlot(), takeSendSlot()];
    expect(slots.every(Boolean)).toBe(true);
    expect(takeSendSlot()).toBeNull();
    slots[0]!();
    slots[0]!();
    const again = takeSendSlot();
    expect(again).not.toBeNull();
    expect(takeSendSlot()).toBeNull();
    [again, slots[1], slots[2]].forEach((free) => free!());
  });

  it.each([['1', 1], ['5', 5], ['abc', 3], ['0', 3]])('NETCASH_MAX_CONCURRENT_SENDS=%j gives a cap of %i', (raw, cap) => {
    process.env.NETCASH_MAX_CONCURRENT_SENDS = raw;
    expect(maxConcurrentSends()).toBe(cap);
  });
});

describe('connectWithin', () => {
  const client = () => ({ release: vi.fn() }) as unknown as PoolClient & { release: ReturnType<typeof vi.fn> };

  it('a connection in time is returned as is', async () => {
    const c = client();
    const pool = { connect: vi.fn(async () => c) } as unknown as Pool;
    expect(await connectWithin(pool, 1000)).toBe(c);
    expect(c.release).not.toHaveBeenCalled();
  });

  it('past the bound: null, and the connection that arrives later is handed straight back once', async () => {
    const c = client();
    let deliver!: (x: PoolClient) => void;
    const pool = { connect: vi.fn(() => new Promise<PoolClient>((r) => { deliver = r; })) } as unknown as Pool;
    expect(await connectWithin(pool, 20)).toBeNull();
    deliver(c);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.release).toHaveBeenCalledTimes(1);
  });

  it('a checkout that fails in time throws; one that fails late is only logged', async () => {
    const failing = { connect: vi.fn(async () => { throw new Error('pool down'); }) } as unknown as Pool;
    await expect(connectWithin(failing, 1000)).rejects.toThrow('pool down');
    let fail!: (e: Error) => void;
    const late = { connect: vi.fn(() => new Promise<PoolClient>((_r, j) => { fail = j; })) } as unknown as Pool;
    expect(await connectWithin(late, 20)).toBeNull();
    fail(new Error('late failure'));
    await new Promise((r) => setTimeout(r, 0));
  });
});
