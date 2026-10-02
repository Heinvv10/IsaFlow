/**
 * D9 round 2: the password re-auth routes. signIn now tells an outage apart from
 * a wrong password, so change-password, change-email and invitation accept must
 * answer an outage 503 + Retry-After, never "Current password is incorrect"
 * (the user would go and change a password that was right), never "enter that
 * account's password", never a bare 500 — and must make no GoTrue write after
 * it. A real rejection keeps its old answer. The real gotrue client runs with
 * only `fetch` stubbed; invitation accept runs on a fake pg client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: logger, apiLogger: logger };
});
vi.mock('@/lib/rateLimit', () => ({
  withRateLimit: (h: unknown) => h,
  checkRateLimit: vi.fn(async () => true),
  chargeRateLimit: vi.fn(async () => ({ admitted: true, windowStart: new Date() })),
  refundRateLimit: vi.fn(async () => undefined),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/impersonationGuard', () => ({
  refuseImpersonatedSession: vi.fn(async () => false),
  respondIfImpersonationForbidden: () => false,
}));
vi.mock('@/lib/auth/withUserAuth', () => ({
  withUserAuth: (h: (q: NextApiRequest, s: NextApiResponse) => unknown) => (q: NextApiRequest, s: NextApiResponse) => {
    (q as unknown as { user: unknown }).user = { id: 'user-1', email: 'user@example.test', claims: {} };
    return h(q, s);
  },
}));

/** Invitation accept: the established-account lookup decides which branch runs. */
const { db } = vi.hoisted(() => ({ db: { established: true, queries: [] as string[] } }));
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  const client = {
    async query(text: string) {
      db.queries.push(text);
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

const { default: changePassword } = await import('../../../pages/api/auth/change-password');
const { default: changeEmail } = await import('../../../pages/api/auth/change-email');
const { default: acceptInvite } = await import('../../../pages/api/invitations/[token]/accept');
const { setAuthUpstreamBoundForTests } = await import('@/lib/auth/authUpstream');

interface Answer { status: number | null; body: unknown; headers: Record<string, unknown> }

async function call(route: unknown, body: unknown, query: Record<string, string> = {}): Promise<Answer> {
  const answer: Answer = { status: null, body: null, headers: {} };
  const res = {
    statusCode: 200, headersSent: false,
    setHeader(k: string, v: unknown) { answer.headers[k.toLowerCase()] = v; return this; },
    getHeader(k: string) { return answer.headers[k.toLowerCase()]; },
    status(code: number) { answer.status = code; this.statusCode = code; return this; },
    json(b: unknown) { answer.body = b; return this; },
  } as unknown as NextApiResponse;
  const req = { method: 'POST', url: '/api/x', body, query, headers: { cookie: '' } } as unknown as NextApiRequest;
  await (route as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);
  return answer;
}

function hangingFetch() {
  return (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) { reject(new Error('unbounded GoTrue call: no abort signal')); return; }
    signal.addEventListener('abort', () => reject(signal.reason));
  });
}

/** `/token` (signIn) answers with `token`; a password/user write (`/admin/users/…`) succeeds. */
function gotrue(token: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/token?grant_type=password')) return token(url, init);
    if (url.includes('/admin/users/')) return Response.json({ id: 'gt-1', email: 'invitee@example.test' });
    throw new Error(`unexpected fetch ${url}`);
  });
}

const OUTAGES: Array<[string, (url: string, init?: RequestInit) => Promise<Response>]> = [
  ['GoTrue 500', async () => new Response('{"code":500}', { status: 500 })],
  ['GoTrue 503', async () => new Response('', { status: 503 })],
  ['a network error', async () => { throw new TypeError('fetch failed'); }],
  ['a timeout', hangingFetch()],
  ['a 200 whose body is cut off mid-read', async () => new Response(
    new ReadableStream({ start(c) { c.error(new TypeError('terminated')); } }), { status: 200 })],
];
const WRONG_PASSWORD = async () => new Response('{"error":"invalid_grant"}', { status: 400 });

function expectOutage(answer: Answer): void {
  expect(answer.status).toBe(503);
  expect(answer.headers['retry-after']).toBe('5');
  expect(answer.body).toMatchObject({ success: false, error: { code: 'AUTH_UNAVAILABLE' } });
}
const writes = (fetch: ReturnType<typeof gotrue>) => fetch.mock.calls.filter(([u]) => String(u).includes('/admin/users/'));

let restoreBound: () => void;
beforeEach(() => {
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service');
  vi.stubEnv('MIGRATION_ADMIN_DATABASE_URL', 'postgres://127.0.0.1:1/x');
  vi.stubEnv('DATABASE_URL', 'postgres://127.0.0.1:1/x');
  restoreBound = setAuthUpstreamBoundForTests(50);
  db.established = true;
  db.queries = [];
});
afterEach(() => { restoreBound(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('POST /api/auth/change-password', () => {
  const body = { currentPassword: 'right-password', newPassword: 'a-new-password-1' };
  it.each(OUTAGES)('%s → 503, and the password is not changed', async (_l, token) => {
    const fetch = gotrue(token);
    vi.stubGlobal('fetch', fetch);
    expectOutage(await call(changePassword, body));
    expect(writes(fetch)).toHaveLength(0);
  });
  it('a wrong current password is still 400 WRONG_PASSWORD', async () => {
    vi.stubGlobal('fetch', gotrue(WRONG_PASSWORD));
    const answer = await call(changePassword, body);
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ error: { code: 'WRONG_PASSWORD' } });
  });
});

describe('POST /api/auth/change-email', () => {
  const body = { newEmail: 'new@example.test', currentPassword: 'right-password' };
  it.each(OUTAGES)('%s → 503, and the email is not changed', async (_l, token) => {
    const fetch = gotrue(token);
    vi.stubGlobal('fetch', fetch);
    expectOutage(await call(changeEmail, body));
    expect(writes(fetch)).toHaveLength(0);
  });
  it('a wrong current password is still 400 WRONG_PASSWORD', async () => {
    vi.stubGlobal('fetch', gotrue(WRONG_PASSWORD));
    const answer = await call(changeEmail, body);
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ error: { code: 'WRONG_PASSWORD' } });
  });
});

describe('POST /api/invitations/[token]/accept', () => {
  const accept = (body: Record<string, unknown>) => call(acceptInvite, { password: 'right-password-1', ...body }, { token: 'raw-invite-token' });
  it.each(OUTAGES)('established account, %s → 503, not SIGN_IN_REQUIRED; no membership written', async (_l, token) => {
    vi.stubGlobal('fetch', gotrue(token));
    expectOutage(await accept({}));
    expect(db.queries.some((q) => /INSERT INTO company_users/.test(q))).toBe(false);
  });
  it.each(OUTAGES)('new account, %s → 503, not a bare 500; no membership written', async (_l, token) => {
    db.established = false;
    vi.stubGlobal('fetch', gotrue(token));
    expectOutage(await accept({}));
    expect(db.queries.some((q) => /INSERT INTO company_users/.test(q))).toBe(false);
  });
  it.each(OUTAGES)('new account, %s while setting the password (step 2) → 503, not 500; signIn never runs', async (_l, outage) => {
    db.established = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/admin/users/')) return outage(url, init);
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    expectOutage(await accept({}));
    expect(fetch.mock.calls.some(([u]) => String(u).includes('/token'))).toBe(false);
    expect(db.queries.some((q) => /INSERT INTO company_users/.test(q))).toBe(false);
  });
  it('new account: a retry after a partial run (password set, then a signIn outage) sets the same password again and completes', async () => {
    db.established = false;
    const session = { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'bearer', user: { id: 'gt-1', email: 'invitee@example.test' } };
    let signIns = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/admin/users/')) return Response.json({ id: 'gt-1', email: 'invitee@example.test' });
      if (url.includes('/token?grant_type=password')) return ++signIns === 1 ? new Response('', { status: 503 }) : Response.json(session);
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    expectOutage(await accept({}));
    expect(db.queries.some((q) => /INSERT INTO company_users/.test(q))).toBe(false);
    expect((await accept({})).status).toBe(200);
    const passwordSets = fetch.mock.calls.filter(([u]) => String(u).includes('/admin/users/'));
    expect(passwordSets).toHaveLength(2);
    expect((passwordSets[0]![1] as RequestInit).body).toBe((passwordSets[1]![1] as RequestInit).body);
    expect(db.queries.filter((q) => /INSERT INTO company_users/.test(q))).toHaveLength(1);
  });
  it('established account, wrong password → still 401 SIGN_IN_REQUIRED', async () => {
    vi.stubGlobal('fetch', gotrue(WRONG_PASSWORD));
    const answer = await accept({});
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ error: { code: 'SIGN_IN_REQUIRED' } });
  });
});
