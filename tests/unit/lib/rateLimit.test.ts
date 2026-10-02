/**
 * Tests for getClientIp — verifies that the last-hop x-forwarded-for entry
 * is used for rate limiting, making IP spoofing via a forged first hop
 * ineffective (S-004 / BL-20), and the clampCost guard.
 *
 * Pure: no database. The counter cases that need PostgreSQL live in
 * tests/integration/rate-limit-counter-db.int.test.ts (R-175: a unit test must
 * not write to a shared database).
 */

import { describe, it, expect } from 'vitest';
import type { NextApiRequest } from 'next';
import { getClientIp, clampCost } from '@/lib/rateLimit';

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

describe('clampCost — positive-integer guard', () => {
  it('passes valid positive integers through', () => {
    expect(clampCost(1)).toBe(1);
    expect(clampCost(40)).toBe(40);
  });
  it('defaults undefined to 1', () => {
    expect(clampCost(undefined)).toBe(1);
  });
  it('clamps zero and negatives to 1', () => {
    expect(clampCost(0)).toBe(1);
    expect(clampCost(-5)).toBe(1);
  });
  it('clamps NaN and Infinity to 1 (Math.max(1,NaN) footgun)', () => {
    expect(clampCost(Number.NaN)).toBe(1);
    expect(clampCost(Number.POSITIVE_INFINITY)).toBe(1);
  });
  it('truncates fractional costs', () => {
    expect(clampCost(2.9)).toBe(2);
  });
})
