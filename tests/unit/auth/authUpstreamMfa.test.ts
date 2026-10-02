/**
 * D9 round 2: the MFA routes' GoTrue calls (gotrue-mfa.ts) are bounded and
 * classified like the session path. A hung GoTrue used to pin these requests
 * forever; an outage now answers 503 + Retry-After, never counts toward the
 * lockout, and never reports "Invalid verification code". A real verdict
 * (422 wrong code, 404 unknown user) keeps its old answer. Only `fetch` is
 * stubbed; the real gotrue-mfa client runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { SignJWT } from 'jose';

vi.mock('@/lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: logger, apiLogger: logger };
});
vi.mock('@/lib/rateLimit', () => ({
  withRateLimit: (h: unknown) => h,
  checkRateLimit: vi.fn(async () => true),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ refuseImpersonatedSession: vi.fn(async () => false) }));
vi.mock('@/lib/auth/requireActiveAccount', () => ({ requireActiveAccount: vi.fn(async () => null) }));
const { recordFailure } = vi.hoisted(() => ({ recordFailure: vi.fn(async () => ({ locked: false })) }));
vi.mock('@/lib/auth/accountLockout', () => ({
  checkLockout: vi.fn(async () => ({ locked: false })),
  recordFailure,
  clearLockout: vi.fn(),
}));

const { default: status } = await import('../../../pages/api/auth/2fa-status');
const { default: confirm } = await import('../../../pages/api/auth/2fa-confirm');
const { default: disable } = await import('../../../pages/api/auth/2fa-disable');
const { default: challenge } = await import('../../../pages/api/auth/2fa-challenge');
const { default: enroll } = await import('../../../pages/api/auth/2fa-enroll');
const { default: resetTwoFactor } = await import('../../../pages/api/admin/users/[id]/reset-2fa');
const { setAuthUpstreamBoundForTests } = await import('@/lib/auth/authUpstream');
const { ACCESS_COOKIE, PENDING_MFA_COOKIE } = await import('@/lib/auth/cookies');

const SIGNING_KEY = 'd9-synthetic-'.repeat(4); // HS256 test key, not a credential
const token = (aal: string) => new SignJWT({ sub: 'user-1', aal, email: 'u@example.test' })
  .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(SIGNING_KEY));

interface Answer { status: number | null; body: unknown; headers: Record<string, unknown> }
async function call(route: unknown, method: string, cookie: string, body: unknown = {}, query: Record<string, string> = {}): Promise<Answer> {
  const answer: Answer = { status: null, body: null, headers: {} };
  const res = {
    statusCode: 200,
    setHeader(k: string, v: unknown) { answer.headers[k.toLowerCase()] = v; return this; },
    getHeader(k: string) { return answer.headers[k.toLowerCase()]; },
    status(code: number) { answer.status = code; this.statusCode = code; return this; },
    json(b: unknown) { answer.body = b; return this; },
  } as unknown as NextApiResponse;
  const req = { method, url: '/api/x', body, query, headers: { cookie } } as unknown as NextApiRequest;
  await (route as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);
  return answer;
}

type Answerer = (init?: RequestInit) => Promise<Response>;
const hang: Answerer = (init) => new Promise<Response>((_resolve, reject) => {
  const signal = init?.signal;
  if (!signal) { reject(new Error('unbounded GoTrue call: no abort signal')); return; }
  signal.addEventListener('abort', () => reject(signal.reason));
});
const OUTAGES: Array<[string, Answerer]> = [
  ['GoTrue 500', async () => new Response('{"code":500}', { status: 500 })],
  ['GoTrue 503', async () => new Response('', { status: 503 })],
  ['a network error', async () => { throw new TypeError('fetch failed'); }],
  ['a timeout (hung GoTrue)', hang],
];
const ok = (body: unknown): Answerer => async () => Response.json(body);

/** Answers each GoTrue path by the first matching pattern; anything else is unexpected. */
function gotrue(routes: Array<[RegExp, Answerer]>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('http://gotrue.test.local', '');
    const hit = routes.find(([re]) => re.test(`${init?.method ?? 'GET'} ${path}`));
    if (!hit) throw new Error(`unexpected fetch ${init?.method} ${path}`);
    return hit[1](init);
  });
}

function expectOutage(answer: Answer): void {
  expect(answer.status).toBe(503);
  expect(answer.headers['retry-after']).toBe('5');
  expect(answer.body).toMatchObject({ success: false, error: { code: 'AUTH_UNAVAILABLE' } });
}

let restoreBound: () => void;
beforeEach(() => {
  vi.stubEnv('JWT_SECRET', SIGNING_KEY);
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service');
  restoreBound = setAuthUpstreamBoundForTests(50);
  recordFailure.mockClear();
});
afterEach(() => { restoreBound(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const CODE = { factor_id: 'factor-1', code: '123456' };
const CHALLENGE_OK: [RegExp, Answerer] = [/^POST \/factors\/factor-1\/challenge$/, ok({ id: 'ch-1', expires_at: 0 })];

describe.each(OUTAGES)('MFA routes when %s', (_label, outage) => {
  it('GET /api/auth/2fa-status → 503', async () => {
    vi.stubGlobal('fetch', gotrue([[/^GET \/user$/, outage]]));
    expectOutage(await call(status, 'GET', `${ACCESS_COOKIE}=${await token('aal2')}`));
  });
  it('POST /api/auth/2fa-confirm → 503, not "Invalid verification code"', async () => {
    vi.stubGlobal('fetch', gotrue([CHALLENGE_OK, [/\/verify$/, outage]]));
    expectOutage(await call(confirm, 'POST', `${ACCESS_COOKIE}=${await token('aal1')}`, CODE));
  });
  it('POST /api/auth/2fa-disable → 503', async () => {
    vi.stubGlobal('fetch', gotrue([[/\/challenge$/, outage]]));
    expectOutage(await call(disable, 'POST', `${ACCESS_COOKIE}=${await token('aal2')}`, CODE));
  });
  it('POST /api/auth/2fa-challenge → 503, and no failed attempt is counted toward the lockout', async () => {
    vi.stubGlobal('fetch', gotrue([CHALLENGE_OK, [/\/verify$/, outage]]));
    expectOutage(await call(challenge, 'POST', `${PENDING_MFA_COOKIE}=${await token('aal1')}`, CODE));
    expect(recordFailure).not.toHaveBeenCalled();
  });
  it('POST /api/auth/2fa-enroll → 503', async () => {
    vi.stubGlobal('fetch', gotrue([[/^POST \/factors$/, outage]]));
    expectOutage(await call(enroll, 'POST', `${ACCESS_COOKIE}=${await token('aal2')}`));
  });
  it('POST /api/admin/users/[id]/reset-2fa: listing the factors fails → 503', async () => {
    vi.stubGlobal('fetch', gotrue([[/^GET \/admin\/users\/user-9$/, outage]]));
    expectOutage(await call(resetTwoFactor, 'POST', '', {}, { id: 'user-9' }));
  });
  it('POST /api/admin/users/[id]/reset-2fa: removing a factor fails → 503, not "0 removed"', async () => {
    vi.stubGlobal('fetch', gotrue([
      [/^GET \/admin\/users\/user-9$/, ok({ factors: [{ id: 'f-1', status: 'verified', factor_type: 'totp' }] })],
      [/^DELETE \/admin\/users\/user-9\/factors\/f-1$/, outage],
    ]));
    expectOutage(await call(resetTwoFactor, 'POST', '', {}, { id: 'user-9' }));
  });
});

describe('MFA verdicts are unchanged', () => {
  it('2fa-challenge: a wrong code (422) is 400 INVALID_CODE and is counted', async () => {
    vi.stubGlobal('fetch', gotrue([CHALLENGE_OK, [/\/verify$/, async () => new Response('{}', { status: 422 })]]));
    const answer = await call(challenge, 'POST', `${PENDING_MFA_COOKIE}=${await token('aal1')}`, CODE);
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ error: { code: 'INVALID_CODE' } });
    expect(recordFailure).toHaveBeenCalledTimes(1);
  });
  it('2fa-confirm: a wrong code (422) is 400 INVALID_CODE', async () => {
    vi.stubGlobal('fetch', gotrue([CHALLENGE_OK, [/\/verify$/, async () => new Response('{}', { status: 422 })]]));
    const answer = await call(confirm, 'POST', `${ACCESS_COOKIE}=${await token('aal1')}`, CODE);
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ error: { code: 'INVALID_CODE' } });
  });
  it('reset-2fa: an unknown user (404) is 404 USER_NOT_FOUND', async () => {
    vi.stubGlobal('fetch', gotrue([[/^GET \/admin\/users\/user-9$/, async () => new Response('{}', { status: 404 })]]));
    const answer = await call(resetTwoFactor, 'POST', '', {}, { id: 'user-9' });
    expect(answer.status).toBe(404);
  });
  it('the MFA call carries an abort signal', async () => {
    const fetch = gotrue([[/^GET \/user$/, ok({ factors: [] })]]);
    vi.stubGlobal('fetch', fetch);
    expect((await call(status, 'GET', `${ACCESS_COOKIE}=${await token('aal2')}`)).status).toBe(200);
    expect((fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
  });
});
