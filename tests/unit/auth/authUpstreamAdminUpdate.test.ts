/**
 * D9 round 4: the routes that call adminUpdateUser after its D9 bound. An
 * outage there (5xx, network error, timeout, cut-off body) is 503
 * AUTH_UNAVAILABLE, not 500. For do-reset-password the single-use token was
 * already consumed: on an outage the route hands it back, so a retry with the
 * SAME link completes the reset instead of stranding the user. A failure that is
 * not an outage keeps its 500 and keeps the token spent.
 *
 * The real gotrue client runs with only `fetch` stubbed. The reset-token store
 * is an in-memory fake of the passwordResetService contract (its SQL is proven
 * against Postgres in tests/integration/d9-password-reset-release.int.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: logger, apiLogger: logger };
});
vi.mock('@/lib/rateLimit', () => ({ withRateLimit: (h: unknown) => h, getClientIp: () => '127.0.0.1' }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ refuseImpersonatedSession: vi.fn(async () => false) }));
vi.mock('@/lib/auth/withUserAuth', () => ({
  withUserAuth: (h: (q: NextApiRequest, s: NextApiResponse) => unknown) => (q: NextApiRequest, s: NextApiResponse) => {
    (q as unknown as { user: unknown }).user = { id: 'user-1', email: 'user@example.test', claims: {} };
    return h(q, s);
  },
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
const { tokens } = vi.hoisted(() => ({ tokens: new Map<string, { userId: string; consumed: boolean }>() }));
vi.mock('@/lib/auth/passwordResetService', () => ({
  consumePasswordResetToken: vi.fn(async (raw: string) => {
    const t = tokens.get(raw);
    if (!t || t.consumed) return null;
    t.consumed = true;
    return { userId: t.userId };
  }),
  releasePasswordResetToken: vi.fn(async (raw: string) => {
    const t = tokens.get(raw);
    if (t) t.consumed = false;
  }),
}));

const { default: changePassword } = await import('../../../pages/api/auth/change-password');
const { default: changeEmail } = await import('../../../pages/api/auth/change-email');
const { default: doReset } = await import('../../../pages/api/auth/do-reset-password');
const { setAuthUpstreamBoundForTests } = await import('@/lib/auth/authUpstream');

interface Answer { status: number | null; body: unknown; headers: Record<string, unknown> }
async function call(route: unknown, body: unknown): Promise<Answer> {
  const answer: Answer = { status: null, body: null, headers: {} };
  const res = {
    statusCode: 200,
    setHeader(k: string, v: unknown) { answer.headers[k.toLowerCase()] = v; return this; },
    getHeader(k: string) { return answer.headers[k.toLowerCase()]; },
    status(code: number) { answer.status = code; this.statusCode = code; return this; },
    json(b: unknown) { answer.body = b; return this; },
  } as unknown as NextApiResponse;
  const req = { method: 'POST', url: '/api/x', body, query: {}, headers: { cookie: '' } } as unknown as NextApiRequest;
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
  ['a timeout', hang],
  ['a 200 whose body is cut off mid-read', async () => new Response(
    new ReadableStream({ start(c) { c.error(new TypeError('terminated')); } }), { status: 200 })],
];
const SESSION = { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'bearer', user: { id: 'user-1', email: 'user@example.test' } };
const ok = (body: unknown): Answerer => async () => Response.json(body);

/** GoTrue by path: sign-in, the admin PUT and logout each get their own answer. */
function gotrue(answers: { token?: Answerer; update?: Answerer; logout?: Answerer }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/token?grant_type=password')) return (answers.token ?? ok(SESSION))(init);
    if (url.includes('/admin/users/')) return (answers.update ?? ok({ id: 'user-1', email: 'user@example.test' }))(init);
    if (url.includes('/logout')) return (answers.logout ?? (async () => new Response(null, { status: 204 })))(init);
    throw new Error(`unexpected fetch ${url}`);
  });
}

function expectOutage(answer: Answer): void {
  expect(answer.status).toBe(503);
  expect(answer.headers['retry-after']).toBe('5');
  expect(answer.body).toMatchObject({ success: false, error: { code: 'AUTH_UNAVAILABLE' } });
}

let restoreBound: () => void;
beforeEach(() => {
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service');
  restoreBound = setAuthUpstreamBoundForTests(50);
  tokens.clear();
  tokens.set('link-1', { userId: 'user-1', consumed: false });
});
afterEach(() => { restoreBound(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const NEW_VALUE = 'n'.repeat(12); // the new password the user types: a test value

describe.each(OUTAGES)('when GoTrue answers the admin update with %s', (_label, outage) => {
  it('POST /api/auth/change-password → 503, not 500', async () => {
    vi.stubGlobal('fetch', gotrue({ update: outage }));
    expectOutage(await call(changePassword, { currentPassword: 'right-password', newPassword: NEW_VALUE }));
  });
  it('POST /api/auth/change-email → 503, not 502 GOTRUE_ERROR', async () => {
    vi.stubGlobal('fetch', gotrue({ update: outage }));
    expectOutage(await call(changeEmail, { newEmail: 'new@example.test', currentPassword: 'right-password' }));
  });
  it('POST /api/auth/do-reset-password → 503, and a retry with the SAME link completes the reset', async () => {
    vi.stubGlobal('fetch', gotrue({ update: outage }));
    expectOutage(await call(doReset, { recoveryToken: 'link-1', newPassword: NEW_VALUE }));
    vi.stubGlobal('fetch', gotrue({}));
    expect((await call(doReset, { recoveryToken: 'link-1', newPassword: NEW_VALUE })).status).toBe(200);
    // and then it is spent for good
    expect((await call(doReset, { recoveryToken: 'link-1', newPassword: NEW_VALUE })).status).toBe(400);
  });
});

describe('do-reset-password: an outage while revoking the old sessions', () => {
  it.each(OUTAGES)('%s at the revoking sign-in → 503, and the same link completes the reset (and the revocation) on retry', async (_l, outage) => {
    vi.stubGlobal('fetch', gotrue({ token: outage }));
    expectOutage(await call(doReset, { recoveryToken: 'link-1', newPassword: NEW_VALUE }));
    vi.stubGlobal('fetch', gotrue({}));
    expect((await call(doReset, { recoveryToken: 'link-1', newPassword: NEW_VALUE })).status).toBe(200);
  });
  // Logout reads no body (204), so a cut-off body is not a case there.
  it.each(OUTAGES.slice(0, 4))('%s at the global logout → 503, and the same link completes on retry', async (_l, outage) => {
    vi.stubGlobal('fetch', gotrue({ logout: outage }));
    expectOutage(await call(doReset, { recoveryToken: 'link-1', newPassword: NEW_VALUE }));
    vi.stubGlobal('fetch', gotrue({}));
    expect((await call(doReset, { recoveryToken: 'link-1', newPassword: NEW_VALUE })).status).toBe(200);
  });
});

describe('a failure that is not an outage keeps its old answer', () => {
  it('do-reset-password: GoTrue 422 on the update is 500 RESET_FAILED and the link stays spent', async () => {
    vi.stubGlobal('fetch', gotrue({ update: async () => new Response('{"msg":"weak"}', { status: 422 }) }));
    const answer = await call(doReset, { recoveryToken: 'link-1', newPassword: NEW_VALUE });
    expect(answer.status).toBe(500);
    expect(answer.body).toMatchObject({ error: { code: 'RESET_FAILED' } });
    expect(tokens.get('link-1')?.consumed).toBe(true);
  });
  it('change-email: GoTrue 422 "already registered" is still 409 EMAIL_TAKEN', async () => {
    vi.stubGlobal('fetch', gotrue({ update: async () => new Response('{"msg":"already registered"}', { status: 422 }) }));
    const answer = await call(changeEmail, { newEmail: 'new@example.test', currentPassword: 'right-password' });
    expect(answer.status).toBe(409);
  });
});
