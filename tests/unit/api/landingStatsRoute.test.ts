/**
 * GET /api/landing-stats keeps its public contract after the aggregate moved
 * to src/lib/landing/landingStats.ts: same JSON shape, same Cache-Control on
 * success, same 500 body on a DB failure, 405 for anything but GET.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const getLandingStats = vi.fn();
vi.mock('@/lib/landing/landingStats', () => ({ getLandingStats: () => getLandingStats() }));

import handler from '../../../pages/api/landing-stats';

interface FakeRes {
  res: NextApiResponse;
  status: () => number;
  body: () => unknown;
  headers: Record<string, string>;
}

function fakeRes(): FakeRes {
  let code = 200;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (k: string, v: string) => { headers[k] = v; return res; },
    status: (c: number) => { code = c; return res; },
    json: (b: unknown) => { payload = b; return res; },
  };
  return { res: res as unknown as NextApiResponse, status: () => code, body: () => payload, headers };
}

const req = (method: string) => ({ method }) as NextApiRequest;

beforeEach(() => { getLandingStats.mockReset(); });

describe('GET /api/landing-stats', () => {
  it('returns the three aggregates with the 1-hour public cache header', async () => {
    getLandingStats.mockResolvedValue({ transactionAmount: 146234567.89, businessCount: 7, invoiceCount: 6612 });
    const r = fakeRes();
    await handler(req('GET'), r.res);
    expect(r.status()).toBe(200);
    expect(r.body()).toEqual({ transactionAmount: 146234567.89, businessCount: 7, invoiceCount: 6612 });
    expect(r.headers['Cache-Control']).toBe('public, s-maxage=3600, stale-while-revalidate=7200');
  });

  it('returns 500 with the same error body, and no cache header, when the stats cannot load', async () => {
    getLandingStats.mockResolvedValue(null);
    const r = fakeRes();
    await handler(req('GET'), r.res);
    expect(r.status()).toBe(500);
    expect(r.body()).toEqual({ error: 'Failed to load stats' });
    expect(r.headers['Cache-Control']).toBeUndefined();
  });

  it('refuses anything but GET without touching the DB', async () => {
    const r = fakeRes();
    await handler(req('POST'), r.res);
    expect(r.status()).toBe(405);
    expect(r.body()).toEqual({ error: 'Method not allowed' });
    expect(getLandingStats).not.toHaveBeenCalled();
  });
});
