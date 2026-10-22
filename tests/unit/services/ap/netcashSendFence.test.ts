/**
 * AP-01 residual 3b: a sender whose process was paused (SIGSTOP, a VM freeze) past SEND_WINDOW_MS after it claimed
 * could send AFTER an operator freed the row and a newer claim sent the batch: paid twice. The sender now carries a
 * fence - a MONOTONIC timestamp taken before the claim transaction begins - and refuses to issue the request when more
 * than SEND_START_DEADLINE_MS have passed. The monotonic clock keeps running while a process is stopped; Date.now()
 * may be stepped by NTP and is not what the fence reads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: vi.fn().mockResolvedValue(undefined) }));

import { startSendFence } from '@/modules/accounting/services/ap/netcashSendFence';
import { submitEftBatch, type NetcashPayment } from '@/modules/accounting/services/ap/netcashService';
import { SEND_START_DEADLINE_MS } from '@/modules/accounting/services/ap/netcashTimeouts';

const PAYMENTS: NetcashPayment[] = [
  { accountHolder: 'Acme', bankCode: '250655', accountNumber: '62000000001', amount: 115000, reference: 'R1' },
];

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** The monotonic clock, advanced by hand: a process stopped for `ms` and continued. */
function pausedClock() {
  let offset = 0;
  const real = performance.now.bind(performance);
  vi.spyOn(performance, 'now').mockImplementation(() => real() + offset);
  return { pause: (ms: number) => { offset += ms; } };
}

describe('startSendFence', () => {
  it('lets a send start until SEND_START_DEADLINE_MS have passed since the fence was taken, then refuses', () => {
    const clock = pausedClock();
    const fence = startSendFence();
    expect(fence.mayStart()).toBe(true);
    clock.pause(SEND_START_DEADLINE_MS - 1_000);
    expect(fence.mayStart()).toBe(true);
    clock.pause(2_000);
    expect(fence.mayStart()).toBe(false);
    expect(fence.elapsedMs()).toBeGreaterThan(SEND_START_DEADLINE_MS);
  });

  it('is monotonic: the wall clock stepping back (or forward) does not move it', () => {
    const fence = startSendFence();
    const wall = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 3_600_000); // NTP stepped the clock back an hour
    expect(fence.mayStart()).toBe(true);
    wall.mockReturnValue(Date.now() + 3_600_000 * 24);
    expect(fence.mayStart()).toBe(true);
  });
});

describe('submitEftBatch with a fence', () => {
  it('a fence that refuses: nothing is sent, and the answer says so (a definite "never got it")', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await submitEftBatch('service-key', 'payouts-key', PAYMENTS, { mayStart: () => false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, outcome: 'rejected', fenced: true });
  });

  it('the fence is asked immediately before the request, with no await between (so no pause can hide in the gap)', async () => {
    const order: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => { order.push('fetch'); return new Response(JSON.stringify({ batchReference: 'NC-1' }), { status: 200 }); }));
    const result = await submitEftBatch('service-key', 'payouts-key', PAYMENTS, { mayStart: () => { order.push('fence'); return true; } });
    expect(order).toEqual(['fence', 'fetch']);
    expect(result).toMatchObject({ success: true, outcome: 'accepted', batchReference: 'NC-1' });
  });

  it('a fence that allows, or none: the request goes (a fast send is unchanged)', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ batchReference: 'NC-2' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await submitEftBatch('service-key', 'payouts-key', PAYMENTS, startSendFence());
    await submitEftBatch('service-key', 'payouts-key', PAYMENTS);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
