/**
 * A bulk upload cannot flood vLLM: callVlmChat holds at most
 * VLM_MAX_CONCURRENCY (default 4) requests in flight and queues the rest
 * (2026-10-16: 7,653 calls in one morning, 1,060 "fetch failed").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callVlmChat } from '@/modules/accounting/services/bank/vlmCore';
import { createSlotLimiter } from '@/modules/accounting/services/bank/vlmLimiter';

const CONFIG = { baseUrl: 'http://vlm.test', model: 'm', apiKey: 'k', timeout: 10_000 };
const ok = () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });

describe('callVlmChat concurrency cap', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('never has more than 4 in flight, and every call completes', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return ok();
    }));
    const results = await Promise.all(Array.from({ length: 11 }, () => callVlmChat(CONFIG, 's', [])));
    expect(results).toEqual(Array(11).fill('ok'));
    expect(peak).toBe(4);
  });

  it('times out a response whose body stalls, and frees its slot', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { signal: AbortSignal }) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      }),
    })));
    const stalled = await Promise.all(Array.from({ length: 4 }, () => callVlmChat({ ...CONFIG, timeout: 50 }, 's', [])));
    expect(stalled).toEqual(Array(4).fill(null));
    vi.stubGlobal('fetch', vi.fn(async () => ok()));
    expect(await callVlmChat(CONFIG, 's', [])).toBe('ok');
  }, 5_000);

  it('releases the slot when a call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed'); }));
    const failed = await Promise.all(Array.from({ length: 6 }, () => callVlmChat(CONFIG, 's', [])));
    expect(failed).toEqual(Array(6).fill(null));
    vi.stubGlobal('fetch', vi.fn(async () => ok()));
    expect(await callVlmChat(CONFIG, 's', [])).toBe('ok');
  });
});

describe('createSlotLimiter', () => {
  it('runs waiting work in arrival order and frees the slot after a throw', async () => {
    const limiter = createSlotLimiter(1);
    const order: number[] = [];
    const boom = limiter.run(async () => { throw new Error('boom'); });
    const runs = [1, 2, 3].map((n) => limiter.run(async () => { order.push(n); }));
    await expect(boom).rejects.toThrow('boom');
    await Promise.all(runs);
    expect(order).toEqual([1, 2, 3]);
  });
});
