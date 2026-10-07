/**
 * als.rollbackOnly (lib/apiJournalDate: a posting call handed back an answer on a transaction it had aborted) —
 * every request owner that reads the flag ROLLS BACK whatever the route answered, and a <5xx answer, which would
 * claim a write that did not land, goes out as the commit-failed 500. A 5xx answer (k071's 503) stands.
 *
 * Each owner is driven with a scripted pg client that records COMMIT / ROLLBACK, and a response that records what
 * actually reached the wire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';
import { SignJWT } from 'jose';
import { pgTypesMock } from '../helpers/pgTypesMock';

const h = vi.hoisted(() => ({
  events: [] as string[], sent: [] as Array<{ status: number; body: string; headers: Record<string, unknown> }>,
}));
const client = {
  query: vi.fn(async (text: string) => {
    const verb = String(text).trim().split(/\s+/)[0]!.toUpperCase();
    if (/FROM company_users|FROM users/i.test(String(text))) {
      return { rows: [{ role: 'super_admin', account_user_id: 'user-1', is_active: true, status: 'active', suspended_at: null }] };
    }
    if (verb === 'COMMIT' || verb === 'ROLLBACK') h.events.push(verb);
    return { rows: [] };
  }),
  release: vi.fn(),
};
vi.mock('pg', () => {
  class Pool { connect = async () => client; on = vi.fn(); }
  return { default: { Pool, ...pgTypesMock() }, Pool, ...pgTypesMock() };
});
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true), getClientIp: vi.fn(() => '10.0.0.1') }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/personalAccessTokens', () => ({
  validatePat: vi.fn(async () => ({ patId: 'pat-1', userId: 'user-1', companyId: 'company-1', scopes: ['read:reports'] })),
}));
vi.mock('@/lib/auth/withPlatformAdmin.pools', () => ({
  getAppPool: () => ({ connect: async () => client }),
  getPlatformAdminPool: () => ({ connect: async () => client }),
}));

const SECRET = 'a'.repeat(40);
const token = () => new SignJWT({ sub: 'user-1', aud: 'authenticated', role: 'authenticated', aal: 'aal2' })
  .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(SECRET));

function makeRes() {
  const res = {
    statusCode: 200, headersSent: false, headers: {} as Record<string, unknown>,
    status(c: number) { res.statusCode = c; return res; },
    setHeader(k: string, v: unknown) { res.headers[k.toLowerCase()] = v; return res; },
    getHeader(k: string) { return res.headers[k.toLowerCase()]; },
    removeHeader(k: string) { delete res.headers[k.toLowerCase()]; },
    json(v: unknown) { return res.end(JSON.stringify(v)); },
    end(body?: unknown) {
      h.sent.push({ status: res.statusCode, body: String(body ?? ''), headers: { ...res.headers } }); return res;
    },
  };
  return res as unknown as NextApiResponse;
}

/** A handler whose posting call handed back (the flag set, as apiJournalDate sets it), then answers `status`. */
function handBackThenAnswer(status: number) {
  return async (_req: unknown, res: NextApiResponse) => {
    const { als } = await import('@/lib/als'); // after vi.resetModules: the owner's own AsyncLocalStorage
    als.getStore()!.rollbackOnly = 'test hand-back';
    h.events.push('HANDLER');
    res.setHeader('Set-Cookie', ['sb-access-token=TARGET; HttpOnly']); // what impersonate sets before answering
    res.setHeader('Location', '/accounting');
    res.status(status).json({ success: status < 400 });
  };
}

type Owner = (status: number) => Promise<void>;
const owners: Array<[string, Owner]> = [
  ['withAuth', async (status) => {
    const { withAuth } = await import('@/lib/auth/withAuth');
    const req = { headers: { cookie: `sb-access-token=${await token()}; active_company_id=company-1` }, url: '/api/t' };
    await withAuth(handBackThenAnswer(status))(req as never, makeRes());
  }],
  ['bearer pipeline', async (status) => {
    const { runBearerRequest } = await import('@/lib/auth/bearerPipeline');
    const req = { headers: { authorization: 'Bearer pat_x' }, url: '/api/t', method: 'POST' };
    await runBearerRequest(req as never, makeRes(), `pat_${'A'.repeat(32)}`, handBackThenAnswer(status));
  }],
  ['withPlatformAdmin', async (status) => {
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    const req = { headers: { cookie: `sb-access-token=${await token()}` }, url: '/api/admin/t' };
    await withPlatformAdmin(handBackThenAnswer(status) as never)(req as never, makeRes());
  }],
];

/** What the owner did with the transaction after the handler ran (withPlatformAdmin's role gate COMMITs before it). */
const finalised = () => h.events.slice(h.events.indexOf('HANDLER') + 1);

beforeEach(() => {
  vi.resetModules();
  h.events.length = 0; h.sent.length = 0;
  process.env.JWT_SECRET = SECRET;
  process.env.GOTRUE_URL = 'http://example.test/auth/v1';
  process.env.DATABASE_URL = 'postgresql://dummy@dummy/test';
  process.env.PLATFORM_ADMIN_DATABASE_URL = 'postgresql://dummy@dummy/test';
  process.env.SENTRY_ENABLED = 'false';
});

describe.each(owners)('%s honours rollbackOnly', (_name, run) => {
  it('a 200 answer: ROLLBACK, no COMMIT, and the client gets the commit-failed 500', async () => {
    await run(200);
    expect(finalised()).toEqual(['ROLLBACK']);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.status).toBe(500);
    expect(JSON.parse(h.sent[0]!.body)).toMatchObject({ success: false, code: 'COMMIT_FAILED' });
    // sec-numrace F1: the replaced answer does not carry the route's session cookie or redirect.
    expect(h.sent[0]!.headers).not.toHaveProperty('set-cookie');
    expect(h.sent[0]!.headers).not.toHaveProperty('location');
  });

  it("a 503 answer (k071's contended outcome): ROLLBACK, and the 503 stands", async () => {
    await run(503);
    expect(finalised()).toEqual(['ROLLBACK']);
    expect(h.sent.map(({ status, body }) => ({ status, body }))).toEqual([{ status: 503, body: JSON.stringify({ success: false }) }]);
    // Replayed over a ROLLBACK: the route's own answer, without the session cookie and redirect it set.
    expect(h.sent[0]!.headers).not.toHaveProperty('set-cookie');
    expect(h.sent[0]!.headers).not.toHaveProperty('location');
  });
});
