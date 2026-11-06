/**
 * An expired access token says nothing about the session. Each cookie wrapper used
 * to clear every auth cookie on it, the refresh cookie included, so the browser's
 * renewal then found nothing to renew from. Drives the REAL verifyToken and jose;
 * only `fetch` is stubbed. Any other refused token still clears everything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { SignJWT } from 'jose';

vi.mock('@sentry/nextjs', () => ({ setTag: vi.fn(), setUser: vi.fn(), captureException: vi.fn(), withScope: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/withPlatformAdmin.pools', () => ({ getAppPool: vi.fn(), getPlatformAdminPool: vi.fn() }));
vi.mock('@/lib/neon', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sql: vi.fn(async () => []),
}));

const { withAuth } = await import('@/lib/auth/withAuth');
const { withUserAuth } = await import('@/lib/auth/withUserAuth');
const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');

const SIGNING_KEY = 'expired-synthetic-'.repeat(3); // HS256 test key, not a credential
const COMPANY = '00000000-0000-0000-0000-000000000001';
const key = (k: string) => new TextEncoder().encode(k);
const token = (exp: string, signWith = SIGNING_KEY) =>
  new SignJWT({ sub: '00000000-0000-0000-0000-0000000000e1', aal: 'aal1' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime(exp).sign(key(signWith));

type Wrapper = (h: (req: unknown, res: NextApiResponse) => unknown) => (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

async function call(wrap: Wrapper, cookie: string) {
  const headers: Record<string, unknown> = {};
  const answer = { status: 0, body: null as unknown };
  const res = {
    statusCode: 200,
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; return this; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    status(code: number) { answer.status = code; return this; },
    json(body: unknown) { answer.body = body; return this; },
  } as unknown as NextApiResponse;
  const req = { url: '/api/x', method: 'GET', headers: { cookie } } as unknown as NextApiRequest;
  await wrap(() => { throw new Error('the handler must not run'); })(req, res);
  const cleared = ([] as unknown[]).concat(headers['set-cookie'] ?? []).map(String)
    .filter((c) => /Max-Age=0/.test(c)).map((c) => c.slice(0, c.indexOf('=')));
  return { ...answer, cleared: [...new Set(cleared)] };
}

const WRAPPERS: Array<[string, Wrapper]> = [
  ['withAuth', withAuth as unknown as Wrapper],
  ['withUserAuth', withUserAuth as unknown as Wrapper],
  ['withPlatformAdmin', withPlatformAdmin as unknown as Wrapper],
];
const jar = (access: string) =>
  `sb-access-token=${access}; sb-refresh-token=live; isaflow_remember_me=0; active_company_id=${COMPANY}`;

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', SIGNING_KEY);
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubEnv('DATABASE_URL', 'postgres://127.0.0.1:1/x');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error_code":"session_not_found"}', { status: 403 })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe.each(WRAPPERS)('%s on a refused access token', (_name, wrap) => {
  it('expired: 401, and only the access cookie goes', async () => {
    const answer = await call(wrap, jar(await token('-1m')));
    expect(answer.status).toBe(401);
    expect(answer.cleared).toEqual(['sb-access-token']);
  });

  it('forged signature: every auth cookie goes', async () => {
    const answer = await call(wrap, jar(await token('1h', 'not-the-real-key-'.repeat(3))));
    expect(answer.status).toBe(401);
    expect(answer.cleared).toEqual(expect.arrayContaining(['sb-access-token', 'sb-refresh-token', 'isaflow_remember_me']));
  });

  it('a session GoTrue has revoked: every auth cookie goes', async () => {
    const answer = await call(wrap, jar(await token('1h')));
    expect(answer.status).toBe(401);
    expect(answer.cleared).toEqual(expect.arrayContaining(['sb-access-token', 'sb-refresh-token']));
  });
});

describe('withUserAuth with no access cookie says whether a renewal can work', () => {
  it.each([
    ['a refresh cookie', 'sb-refresh-token=live', true],
    ['no refresh cookie', 'active_company_id=x', false],
    ['an empty refresh cookie', 'sb-refresh-token=', false],
  ])('%s', async (_label, cookie, renewable) => {
    const answer = await call(withUserAuth as unknown as Wrapper, cookie);
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ error: { code: 'UNAUTHORIZED', renewable } });
    expect(answer.cleared).toEqual([]);
  });
});
