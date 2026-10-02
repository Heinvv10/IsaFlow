/**
 * D9: the session routes outside the cookie wrappers. A GoTrue outage at
 * refresh, login, 2FA enrolment, the App Router helper or the OAuth consent
 * page must not end the session, lock the account or send the user to /login.
 * Every case drives the real gotrue client with only `fetch` stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({
  withRateLimit: (h: unknown) => h,
  checkRateLimit: vi.fn(async () => true),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/auth/requireActiveAccount', () => ({ requireActiveAccount: vi.fn(async () => null) }));
const { recordFailure } = vi.hoisted(() => ({ recordFailure: vi.fn(async () => ({ locked: false })) }));
vi.mock('@/lib/auth/accountLockout', () => ({
  checkLockout: vi.fn(async () => ({ locked: false })),
  recordFailure,
  clearLockout: vi.fn(),
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ refuseImpersonatedSession: vi.fn(async () => false) }));
vi.mock('@/lib/auth/gotrue-mfa', () => ({
  enrollTotp: vi.fn(async () => ({ id: 'factor-1' })),
  listFactors: vi.fn(async () => ({ totp: [] })),
  GotrueMfaError: class GotrueMfaError extends Error {},
}));

const { default: refreshRoute } = await import('../../../pages/api/auth/refresh');
const { default: loginRoute } = await import('../../../pages/api/auth/login');
const { default: enrollRoute } = await import('../../../pages/api/auth/2fa-enroll');
const { requireAuth, getUserFromRequest } = await import('@/lib/auth/app-router');
const { getServerSideProps: authorizeProps } = await import('../../../pages/oauth/authorize');
const { setAuthUpstreamBoundForTests, AuthUpstreamUnavailableError } = await import('@/lib/auth/authUpstream');
const { ACCESS_COOKIE, REFRESH_COOKIE } = await import('@/lib/auth/cookies');

const SIGNING_KEY = 'd9-synthetic-'.repeat(4); // HS256 test key, not a credential
const USER = '00000000-0000-0000-0000-0000000000d9';

async function aal1Token(): Promise<string> {
  return new SignJWT({ sub: USER, aal: 'aal1', email: 'd9@example.test' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(SIGNING_KEY));
}

interface Answer { status: number | null; body: unknown; headers: Record<string, unknown> }

async function callRoute(route: unknown, cookie: string, body: unknown = {}): Promise<Answer> {
  const answer: Answer = { status: null, body: null, headers: {} };
  const res = {
    statusCode: 200,
    setHeader(k: string, v: unknown) { answer.headers[k.toLowerCase()] = v; return this; },
    getHeader(k: string) { return answer.headers[k.toLowerCase()]; },
    status(code: number) { answer.status = code; this.statusCode = code; return this; },
    json(b: unknown) { answer.body = b; return this; },
  } as unknown as NextApiResponse;
  const req = { method: 'POST', url: '/api/auth/x', body, headers: { cookie } } as unknown as NextApiRequest;
  await (route as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);
  return answer;
}

function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) { reject(new Error('unbounded GoTrue call: no abort signal')); return; }
    signal.addEventListener('abort', () => reject(signal.reason));
  }));
}

const OUTAGES: Array<[string, () => ReturnType<typeof vi.fn>]> = [
  ['GoTrue 500', () => vi.fn(async () => new Response('{"code":500}', { status: 500 }))],
  ['GoTrue 502', () => vi.fn(async () => new Response('', { status: 502 }))],
  ['GoTrue 503', () => vi.fn(async () => new Response('', { status: 503 }))],
  ['a network error', () => vi.fn(async () => { throw new TypeError('fetch failed'); })],
  ['a timeout', hangingFetch],
];

function expectOutageAnswer(answer: Answer): void {
  expect(answer.status).toBe(503);
  expect(answer.headers['retry-after']).toBe('5');
  expect(answer.headers['set-cookie']).toBeUndefined();
  expect(answer.body).toMatchObject({ success: false, error: { code: 'AUTH_UNAVAILABLE' } });
}

let restoreBound: () => void;
beforeEach(() => {
  vi.stubEnv('JWT_SECRET', SIGNING_KEY);
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-anon');
  restoreBound = setAuthUpstreamBoundForTests(50);
  recordFailure.mockClear();
});
afterEach(() => { restoreBound(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('POST /api/auth/refresh', () => {
  const cookie = `${REFRESH_COOKIE}=rt-1`;
  it.each(OUTAGES)('%s → 503 + Retry-After, the session cookies are kept', async (_l, makeFetch) => {
    vi.stubGlobal('fetch', makeFetch());
    expectOutageAnswer(await callRoute(refreshRoute, cookie));
  });
  it.each([400, 401])('GoTrue %i (refresh token revoked or reused) → 401 and the cookies are cleared', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid_grant"}', { status })));
    const answer = await callRoute(refreshRoute, cookie);
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ error: { code: 'REFRESH_FAILED' } });
    expect((answer.headers['set-cookie'] as string[]).some((c) => c.startsWith(`${ACCESS_COOKIE}=;`))).toBe(true);
  });
});

describe('POST /api/auth/login', () => {
  const body = { email: 'd9@example.test', password: 'correct horse' };
  it.each(OUTAGES)('%s → 503, and no failed attempt is counted toward the lockout', async (_l, makeFetch) => {
    vi.stubGlobal('fetch', makeFetch());
    const answer = await callRoute(loginRoute, '', body);
    expect(answer.status).toBe(503);
    expect(answer.headers['retry-after']).toBe('5');
    expect(recordFailure).not.toHaveBeenCalled();
  });
  it('GoTrue 400 (wrong password) → 401 INVALID_CREDENTIALS and the failure is counted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })));
    const answer = await callRoute(loginRoute, '', body);
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
    expect(recordFailure).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/auth/2fa-enroll', () => {
  it.each(OUTAGES)('%s → 503 + Retry-After', async (_l, makeFetch) => {
    vi.stubGlobal('fetch', makeFetch());
    expectOutageAnswer(await callRoute(enrollRoute, `${ACCESS_COOKIE}=${await aal1Token()}`));
  });
  it('GoTrue 401 → 401 INVALID_TOKEN', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const answer = await callRoute(enrollRoute, `${ACCESS_COOKIE}=${await aal1Token()}`);
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ error: { code: 'INVALID_TOKEN' } });
  });
});

describe('App Router requireAuth', () => {
  async function request(): Promise<NextRequest> {
    return new NextRequest('http://app.test/api/x', { headers: { cookie: `${ACCESS_COOKIE}=${await aal1Token()}` } });
  }
  it.each(OUTAGES)('%s → 503 + Retry-After; getUserFromRequest throws instead of saying "no user"', async (_l, makeFetch) => {
    vi.stubGlobal('fetch', makeFetch());
    const [user, refusal] = await requireAuth(await request());
    expect(user).toBeNull();
    expect(refusal?.status).toBe(503);
    expect(refusal?.headers.get('retry-after')).toBe('5');
    await expect(getUserFromRequest(await request())).rejects.toBeInstanceOf(AuthUpstreamUnavailableError);
  });
  it('GoTrue 401 → 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const [, refusal] = await requireAuth(await request());
    expect(refusal?.status).toBe(401);
  });
});

describe('GET /oauth/authorize (getServerSideProps)', () => {
  async function ctx() {
    return {
      req: { headers: { cookie: `${ACCESS_COOKIE}=${await aal1Token()}` } },
      res: {}, query: {}, resolvedUrl: '/oauth/authorize?client_id=c',
    } as unknown as Parameters<typeof authorizeProps>[0];
  }
  it.each(OUTAGES)('%s → the outage propagates; the user is not sent to /login', async (_l, makeFetch) => {
    vi.stubGlobal('fetch', makeFetch());
    await expect(authorizeProps(await ctx())).rejects.toBeInstanceOf(AuthUpstreamUnavailableError);
  });
  it('GoTrue 401 → redirect to /login with a returnTo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(authorizeProps(await ctx())).resolves.toMatchObject({
      redirect: { destination: expect.stringMatching(/^\/login\?returnTo=/) },
    });
  });
});
