/**
 * Tests for getClientIp — verifies that the last-hop x-forwarded-for entry
 * is used for rate limiting, making IP spoofing via a forged first hop
 * ineffective (S-004 / BL-20).
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { NextApiRequest } from 'next';
import { getClientIp, checkRateLimit, clearRateLimitCache } from '@/lib/rateLimit';
import { sql } from '@/lib/neon';

function makeReq(xff: string | string[] | undefined, remoteAddress = '10.0.0.1'): NextApiRequest {
  return {
    headers: {
      ...(xff !== undefined ? { 'x-forwarded-for': xff } : {}),
    },
    socket: { remoteAddress },
  } as unknown as NextApiRequest;
}

describe('getClientIp', () => {
  it('returns the LAST hop when x-forwarded-for has multiple entries (spoofed first hop ignored)', () => {
    const req = makeReq('1.1.1.1, 2.2.2.2, 3.3.3.3');
    expect(getClientIp(req)).toBe('3.3.3.3');
  });

  it('returns the single entry when x-forwarded-for has one IP', () => {
    const req = makeReq('5.6.7.8');
    expect(getClientIp(req)).toBe('5.6.7.8');
  });

  it('returns the last entry when x-forwarded-for has exactly two hops', () => {
    const req = makeReq('192.168.1.1, 172.16.0.1');
    expect(getClientIp(req)).toBe('172.16.0.1');
  });

  it('falls back to socket.remoteAddress when no x-forwarded-for header is present', () => {
    const req = makeReq(undefined, '203.0.113.5');
    expect(getClientIp(req)).toBe('203.0.113.5');
  });

  it('returns "unknown" when neither x-forwarded-for nor remoteAddress is available', () => {
    // Override socket to have no remoteAddress at all
    const req = {
      headers: {},
      socket: {},
    } as unknown as NextApiRequest;
    expect(getClientIp(req)).toBe('unknown');
  });

  it('handles array-valued x-forwarded-for headers (takes last segment of first element)', () => {
    // Next.js may join multi-value headers; the array form holds the raw value
    const req = makeReq(['1.1.1.1, 9.9.9.9']);
    expect(getClientIp(req)).toBe('9.9.9.9');
  });

  it('trims whitespace from each IP segment', () => {
    const req = makeReq('  1.1.1.1 ,  2.2.2.2 ,  3.3.3.3 ');
    expect(getClientIp(req)).toBe('3.3.3.3');
  });
});

// These tests require a real Neon DB — skip when only the dummy fallback URL is set.
const hasRealDb = !!(process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('dummy'));
describe('checkRateLimit — Neon-backed persistence (BL-21)', () => {
  const KEY = 'test:rl:bl21';

  beforeAll(async () => {
    if (!hasRealDb) return;
    await sql`DELETE FROM rate_limit_counters WHERE key = ${KEY}`;
  });

  afterEach(async () => {
    if (!hasRealDb) return;
    // Clear both DB and LRU so each test starts from a clean state.
    await sql`DELETE FROM rate_limit_counters WHERE key = ${KEY}`;
    clearRateLimitCache();
  });

  it.skipIf(!hasRealDb)('blocks the (N+1)-th request within the window', async () => {
    // The LRU short-circuit may absorb 1 call per fresh-LRU window (when count
    // is below 50% of max). Using max=5, the LRU masks exactly 1 call, so we
    // make 6 calls to ensure the DB counter reaches 5 (all 5 allowed slots
    // consumed) before the final blocked-check call.
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    }
    clearRateLimitCache(); // fresh pod sees the DB state
    await checkRateLimit(KEY, { max: 5, windowSecs: 60 }); // ensures count=5 in DB
    clearRateLimitCache(); // another fresh pod
    const blocked = await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    expect(blocked).toBe(false);
  });

  it.skipIf(!hasRealDb)('resets the window after expiry (simulated via DB update)', async () => {
    for (let i = 0; i < 5; i++) await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    // simulate window expiry
    await sql`UPDATE rate_limit_counters SET window_start = NOW() - INTERVAL '2 minutes' WHERE key = ${KEY}`;
    const allowed = await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    expect(allowed).toBe(true);
  });

  it.skipIf(!hasRealDb)('two independent callers share the same counter (cross-pod)', async () => {
    // "Pod A" makes 4 calls. The LRU short-circuit may absorb at most 1
    // (count < 50% of max=5 → only when count=1), so DB sees at least 3.
    for (let i = 0; i < 4; i++) await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    // Simulate "pod B" with an empty LRU (fresh process/pod).
    clearRateLimitCache();
    // Pod B makes 3 more calls. DB counter is shared, so it accumulates.
    // Total DB increments >= 6 (> max=5), last call must be blocked.
    for (let i = 0; i < 2; i++) await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    clearRateLimitCache();
    const blocked = await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    expect(blocked).toBe(false);
  });
});
