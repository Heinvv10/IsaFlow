/**
 * D9 round 3: an outage must not spend the user's attempt budget. Each route
 * still charges BEFORE it calls GoTrue (so a request that dies is counted), and
 * hands the units back only AFTER the outcome is a classified upstream outage —
 * no password or code was judged. Genuine failures stay counted.
 *
 * The rate limiter is an in-memory fake of the chargeRateLimit/refundRateLimit
 * contract (count per key, refuse past `max`); the real gotrue clients run with
 * only `fetch` stubbed; invitation accept runs on a fake pg client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { SignJWT } from 'jose';

const { limiter } = vi.hoisted(() => {
  const counts = new Map<string, number>();
  return {
    limiter: {
      counts,
      async charge(key: string, opts: { max: number; cost?: number }) {
        const cost = opts.cost ?? 1;
        const used = counts.get(key) ?? 0;
        if (used + cost > opts.max) return { admitted: false, windowStart: null };
        counts.set(key, used + cost);
        return { admitted: true, windowStart: 'window-1' };
      },
      async refund(key: string, units: number) { counts.set(key, Math.max(0, (counts.get(key) ?? 0) - units)); },
    },
  };
});
vi.mock('@/lib/rateLimit', () => ({
  withRateLimit: (h: unknown) => h,
  chargeRateLimit: (k: string, o: { max: number; cost?: number }) => limiter.charge(k, o),
  checkRateLimit: async (k: string, o: { max: number; cost?: number }) => (await limiter.charge(k, o)).admitted,
  refundRateLimit: (k: string, u: number) => limiter.refund(k, u),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: logger, apiLogger: logger };
});
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/impersonationGuard', () => ({
  refuseImpersonatedSession: vi.fn(async () => false),
  respondIfImpersonationForbidden: () => false,
}));
vi.mock('@/lib/auth/requireActiveAccount', () => ({ requireActiveAccount: vi.fn(async () => null) }));
vi.mock('@/lib/auth/accountLockout', () => ({
  checkLockout: vi.fn(async () => ({ locked: false })),
  recordFailure: vi.fn(async () => ({ locked: false })),
  clearLockout: vi.fn(),
}));
vi.mock('@/lib/neon', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The invitation lookup is the only `sql` read that must find a row; the rest (memberships, standing) may be empty.
  sql: vi.fn(async (strings: TemplateStringsArray) => (strings.join('?').includes('FROM company_invitations')
    ? [{ id: 'inv-1', email: 'invitee@example.test', role: 'viewer', company_id: 'co-1', gotrue_user_id: 'gt-1' }]
    : [])),
}));
const { db } = vi.hoisted(() => ({ db: { established: true } }));
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  const client = {
    async query(text: string) {
      if (/FROM company_invitations/.test(text)) {
        return { rows: [{ id: 'inv-1', email: 'invitee@example.test', role: 'viewer', company_id: 'co-1', gotrue_user_id: 'gt-1' }], rowCount: 1 };
      }
      if (/FROM users WHERE id/.test(text)) return db.established ? { rows: [{ id: 'gt-1' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release() { /* pooled */ },
  };
  class Pool { on(): void { /* error listener */ } connect() { return Promise.resolve(client); } }
  return { default: { ...actual.default, Pool } };
});

const { default: challenge } = await import('../../../pages/api/auth/2fa-challenge');
const { default: confirm } = await import('../../../pages/api/auth/2fa-confirm');
const { default: disable } = await import('../../../pages/api/auth/2fa-disable');
const { default: login } = await import('../../../pages/api/auth/login');
const { default: acceptInvite } = await import('../../../pages/api/invitations/[token]/accept');
const { ACCESS_COOKIE, PENDING_MFA_COOKIE } = await import('@/lib/auth/cookies');

const SIGNING_KEY = 'd9-synthetic-'.repeat(4); // HS256 test key, not a credential
const token = (sub = 'gt-1') => new SignJWT({ sub, aal: 'aal1', email: 'invitee@example.test' })
  .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(SIGNING_KEY));

async function call(route: unknown, cookie: string, body: unknown, query: Record<string, string> = {}): Promise<number | null> {
  let status: number | null = null;
  const headers: Record<string, unknown> = {};
  const res = {
    statusCode: 200,
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; return this; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    status(code: number) { status = code; this.statusCode = code; return this; },
    json() { return this; },
  } as unknown as NextApiResponse;
  const req = { method: 'POST', url: '/api/x', body, query, headers: { cookie } } as unknown as NextApiRequest;
  await (route as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);
  return status;
}

/** GoTrue answers by path; `mode` flips between an outage, a verdict and success per attempt. */
let mode: 'outage' | 'wrong' | 'ok' = 'ok';
const SESSION = { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'bearer', user: { id: 'gt-1', email: 'invitee@example.test' } };
function gotrue() {
  return vi.fn(async (url: string) => {
    const path = url.replace('http://gotrue.test.local', '');
    if (/^\/admin\/users\//.test(path)) return Response.json({ id: 'gt-1' });
    if (/\/challenge$/.test(path)) return Response.json({ id: 'ch-1', expires_at: 0 });
    if (path === '/user') return Response.json({ id: 'gt-1', factors: [] });
    if (mode === 'outage') return new Response('{"code":503}', { status: 503 });
    if (mode === 'wrong') return new Response('{}', { status: /\/verify$/.test(path) ? 422 : 400 });
    if (/\/verify$/.test(path)) return Response.json(SESSION);
    if (/^\/factors\/factor-1$/.test(path)) return Response.json({});
    if (/^\/token/.test(path)) return Response.json(SESSION);
    throw new Error(`unexpected fetch ${path}`);
  });
}

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', SIGNING_KEY);
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service');
  vi.stubEnv('MIGRATION_ADMIN_DATABASE_URL', 'postgres://127.0.0.1:1/x');
  vi.stubEnv('DATABASE_URL', 'postgres://127.0.0.1:1/x');
  limiter.counts.clear();
  db.established = true;
  vi.stubGlobal('fetch', gotrue());
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const CODE = { factor_id: 'factor-1', code: '123456' };
const ROUTES: Array<[string, unknown, () => Promise<string>, number, number]> = [
  // name, route, cookie, attempts allowed, wrong-answer status
  ['2fa-challenge (5 per factor / 15 min)', challenge, async () => `${PENDING_MFA_COOKIE}=${await token()}`, 5, 400],
  ['2fa-confirm (5 per factor / 15 min)', confirm, async () => `${ACCESS_COOKIE}=${await token()}`, 5, 400],
  ['2fa-disable (5 per factor / 15 min)', disable, async () => `${ACCESS_COOKIE}=${await token()}`, 5, 400],
];

/**
 * allowed-1 wrong answers, then five outages, then one more wrong answer (still admitted: it is only the
 * allowed-th genuine attempt), then a refusal. An outage refund that returned more than its own units
 * (a double refund, or one that ate an earlier genuine charge) would admit the last call too.
 */
async function wrongThenOutagesThenWrong(attempt: () => Promise<number | null>, allowed: number, wrongStatus: number) {
  mode = 'wrong';
  for (let i = 0; i < allowed - 1; i++) expect(await attempt()).toBe(wrongStatus);
  mode = 'outage';
  for (let i = 0; i < 5; i++) expect(await attempt()).toBe(503);
  mode = 'wrong';
  expect(await attempt()).toBe(wrongStatus);
  expect(await attempt()).toBe(429);
}

describe.each(ROUTES)('%s', (_name, route, cookie, allowed, wrongStatus) => {
  it('an outage refund returns only its own units: wrong codes around outages still reach the limit', async () => {
    await wrongThenOutagesThenWrong(async () => call(route, await cookie(), CODE), allowed, wrongStatus);
  });
  it(`${allowed} outage retries leave the user able to verify`, async () => {
    mode = 'outage';
    for (let i = 0; i < allowed; i++) expect(await call(route, await cookie(), CODE)).toBe(503);
    mode = 'ok';
    expect(await call(route, await cookie(), CODE)).toBe(200);
  });
  it(`${allowed} wrong codes are still counted: the next attempt is refused`, async () => {
    mode = 'wrong';
    for (let i = 0; i < allowed; i++) expect(await call(route, await cookie(), CODE)).toBe(wrongStatus);
    expect(await call(route, await cookie(), CODE)).toBe(429);
  });
});

describe('POST /api/auth/login (10 per email / 15 min)', () => {
  const body = { email: 'invitee@example.test', password: 'right-password-1' };
  it('10 outage retries leave the user able to sign in', async () => {
    mode = 'outage';
    for (let i = 0; i < 10; i++) expect(await call(login, '', body)).toBe(503);
    mode = 'ok';
    expect(await call(login, '', body)).toBe(200);
  });
  it('an outage refund returns only its own units: wrong passwords around outages still reach the limit', async () => {
    await wrongThenOutagesThenWrong(() => call(login, '', body), 10, 401);
  });
  it('10 wrong passwords are still counted: the next attempt is refused', async () => {
    mode = 'wrong';
    for (let i = 0; i < 10; i++) expect(await call(login, '', body)).toBe(401);
    expect(await call(login, '', body)).toBe(429);
  });
});

describe('POST /api/invitations/[token]/accept (10 attempts / hour)', () => {
  const accept = () => call(acceptInvite, '', { password: 'right-password-1' }, { token: 'raw-invite-token' });
  it.each([true, false])('established=%s: 10 outage retries leave the invitee able to accept', async (established) => {
    db.established = established;
    mode = 'outage';
    for (let i = 0; i < 10; i++) expect(await accept()).toBe(503);
    mode = 'ok';
    expect(await accept()).toBe(200);
  });
  it('an outage refund returns only its own units: wrong passwords around outages still reach the limit', async () => {
    await wrongThenOutagesThenWrong(accept, 10, 401);
  });
  it('10 wrong passwords for an established account are still counted', async () => {
    mode = 'wrong';
    for (let i = 0; i < 10; i++) expect(await accept()).toBe(401);
    expect(await accept()).toBe(429);
  });
});
