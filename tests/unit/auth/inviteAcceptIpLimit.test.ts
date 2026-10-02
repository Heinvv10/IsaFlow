/**
 * D9 round 4 (security LOW): invitation accept refunds its per-token charge on
 * a classified GoTrue outage, so on its own nothing bounded how many GoTrue
 * calls one holder of a valid link could drive during an outage. The route now
 * also carries a per-IP limit (20 per 15 min) that is charged before anything
 * else and NEVER refunded.
 *
 * The real `withRateLimit` runs; only the counter underneath it
 * (`@/lib/rateLimitCore`) is an in-memory fake of its charge/refund contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { limiter } = vi.hoisted(() => {
  const counts = new Map<string, number>();
  const charge = async (key: string, opts: { max: number; cost?: number }) => {
    const cost = opts.cost ?? 1;
    const used = counts.get(key) ?? 0;
    if (used + cost > opts.max) return { admitted: false, windowStart: null };
    counts.set(key, used + cost);
    return { admitted: true, windowStart: 'window-1' };
  };
  return {
    limiter: {
      counts,
      charge,
      async check(key: string, opts: { max: number; cost?: number }) { return (await charge(key, opts)).admitted; },
      async refund(key: string, units: number) { counts.set(key, Math.max(0, (counts.get(key) ?? 0) - units)); },
    },
  };
});
vi.mock('@/lib/rateLimitCore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  chargeRateLimit: (k: string, o: { max: number; cost?: number }) => limiter.charge(k, o),
  checkRateLimit: (k: string, o: { max: number; cost?: number }) => limiter.check(k, o),
  refundRateLimit: (k: string, u: number) => limiter.refund(k, u),
}));
vi.mock('@/lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: logger, apiLogger: logger };
});
vi.mock('@/lib/neon', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sql: vi.fn(async (strings: TemplateStringsArray) => (strings.join('?').includes('FROM company_invitations')
    ? [{ id: 'inv-1', email: 'invitee@example.test', role: 'viewer', company_id: 'co-1', gotrue_user_id: 'gt-1' }]
    : [])),
}));
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  const client = {
    async query(text: string) {
      return /FROM users WHERE id/.test(text) ? { rows: [{ id: 'gt-1' }], rowCount: 1 } : { rows: [], rowCount: 0 };
    },
    release() { /* pooled */ },
  };
  class Pool { on(): void { /* error listener */ } connect() { return Promise.resolve(client); } }
  return { default: { ...actual.default, Pool } };
});

const { default: acceptInvite } = await import('../../../pages/api/invitations/[token]/accept');

async function accept(ip: string): Promise<number | null> {
  let status: number | null = null;
  const headers: Record<string, unknown> = {};
  const res = {
    statusCode: 200,
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; return this; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    status(code: number) { status = code; this.statusCode = code; return this; },
    json() { return this; },
  } as unknown as NextApiResponse;
  const req = {
    method: 'POST', url: '/api/invitations/raw/accept', body: { password: 'right-password-1' }, query: { token: 'raw-invite-token' },
    headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip },
  } as unknown as NextApiRequest;
  await (acceptInvite as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);
  return status;
}

beforeEach(() => {
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubEnv('MIGRATION_ADMIN_DATABASE_URL', 'postgres://127.0.0.1:1/x');
  vi.stubEnv('DATABASE_URL', 'postgres://127.0.0.1:1/x');
  limiter.counts.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":503}', { status: 503 })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('POST /api/invitations/[token]/accept during a GoTrue outage', () => {
  it('one IP gets 20 attempts per 15 minutes, outages included; the 21st is refused before GoTrue is called', async () => {
    for (let i = 0; i < 20; i++) expect(await accept('203.0.113.7')).toBe(503);
    const gotrueCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(await accept('203.0.113.7')).toBe(429);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(gotrueCalls);
  });

  it('the per-IP charge is never refunded, while the per-token charge is', async () => {
    for (let i = 0; i < 3; i++) expect(await accept('203.0.113.8')).toBe(503);
    const ipKeys = [...limiter.counts].filter(([k]) => k.includes('203.0.113.8'));
    expect(ipKeys).toHaveLength(1);
    expect(ipKeys[0]![1]).toBe(3);
    const tokenKeys = [...limiter.counts].filter(([k]) => k.startsWith('invite-accept:') && !k.includes(':ip:'));
    expect(tokenKeys.map(([, n]) => n)).toEqual([0]);
  });

  it('another IP is not affected by the first one hitting its limit', async () => {
    for (let i = 0; i < 20; i++) await accept('203.0.113.9');
    expect(await accept('203.0.113.9')).toBe(429);
    expect(await accept('198.51.100.1')).toBe(503);
  });
});
