/**
 * A bulk upload cannot flood vLLM: callVlmChat holds at most
 * VLM_MAX_CONCURRENCY requests in flight and queues the rest (2026-10-16:
 * 7,653 calls in one morning, 1,060 "fetch failed").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callVlmChat } from '@/modules/accounting/services/bank/vlmCore';

const CONFIG = { baseUrl: 'http://vlm.test', model: 'm', apiKey: 'k', timeout: 10_000 };

describe('callVlmChat concurrency cap', () => {
  beforeEach(() => { process.env.VLM_MAX_CONCURRENCY = '2'; });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VLM_MAX_CONCURRENCY;
  });

  it('never has more than the cap in flight, and every call completes', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    }));
    const results = await Promise.all(Array.from({ length: 7 }, () => callVlmChat(CONFIG, 's', [])));
    expect(results).toEqual(Array(7).fill('ok'));
    expect(peak).toBe(2);
  });

  it('releases the slot when a call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed'); }));
    const failed = await Promise.all(Array.from({ length: 3 }, () => callVlmChat(CONFIG, 's', [])));
    expect(failed).toEqual([null, null, null]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) })));
    expect(await callVlmChat(CONFIG, 's', [])).toBe('ok');
  });
});
