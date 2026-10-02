/**
 * D9: an auth-provider outage must not log users out.
 *
 * On 2026-10-02 the shared Postgres ran out of connection slots, GoTrue's
 * `GET /user` answered 500, and every AAL1 request was answered 401 with its
 * cookies cleared. These tests drive the REAL verifyToken through each cookie
 * wrapper with only `fetch` stubbed: an outage (5xx, network error, timeout)
 * must be 503 + Retry-After with no Set-Cookie; a real rejection (401/403)
 * stays 401 and clears the cookies; a valid session still gets through.
 *
 * Acceptance is observed without a database: withAuth's and withPlatformAdmin's
 * pools reject `connect()` with a sentinel, so "reached the pool" means the
 * token was accepted. An outage must never reach it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { SignJWT } from 'jose';

const CONNECT_SENTINEL = 'authUpstreamOutage: reached the pool';

vi.mock('@sentry/nextjs', () => ({ setTag: vi.fn(), setUser: vi.fn(), captureException: vi.fn(), withScope: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  class Pool {
    on(): void { /* the real pool registers an error listener */ }
    connect(): Promise<never> { return Promise.reject(new Error(CONNECT_SENTINEL)); }
  }
  return { default: { ...actual.default, Pool } };
});
vi.mock('@/lib/auth/withPlatformAdmin.pools', () => {
  const pool = { connect: () => Promise.reject(new Error(CONNECT_SENTINEL)) };
  return { getAppPool: () => pool, getPlatformAdminPool: () => pool };
});
// withUserAuth's standing lookup: no users row means "not provisioned yet", which passes.
vi.mock('@/lib/neon', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sql: vi.fn(async () => []),
}));

const { withAuth } = await import('@/lib/auth/withAuth');
const { withUserAuth } = await import('@/lib/auth/withUserAuth');
const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
const { setAuthUpstreamBoundForTests } = await import('@/lib/auth/authUpstream');
const { ACCESS_COOKIE, ACTIVE_COMPANY_COOKIE } = await import('@/lib/auth/cookies');

const SIGNING_KEY = 'd9-synthetic-'.repeat(4); // HS256 test key, not a credential
const USER = '00000000-0000-0000-0000-0000000000d9';
const COMPANY = '00000000-0000-0000-0000-000000000001';

/** AAL1: verifyToken must ask GoTrue `/user` for the factor state. */
async function aal1Token(): Promise<string> {
  return new SignJWT({ sub: USER, aal: 'aal1', email: 'd9@example.test' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(SIGNING_KEY));
}

interface Answer { status: number | null; body: unknown; headers: Record<string, unknown>; handlerRan: boolean }

type Wrapper = (h: (req: unknown, res: NextApiResponse) => unknown) => (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

async function call(wrap: Wrapper): Promise<Answer> {
  const answer: Answer = { status: null, body: null, headers: {}, handlerRan: false };
  const res = {
    statusCode: 200,
    setHeader(k: string, v: unknown) { answer.headers[k.toLowerCase()] = v; return this; },
    getHeader(k: string) { return answer.headers[k.toLowerCase()]; },
    status(code: number) { answer.status = code; this.statusCode = code; return this; },
    json(body: unknown) { answer.body = body; return this; },
  } as unknown as NextApiResponse;
  const req = {
    url: '/api/d9', method: 'GET',
    headers: { cookie: `${ACCESS_COOKIE}=${await aal1Token()}; ${ACTIVE_COMPANY_COOKIE}=${COMPANY}` },
  } as unknown as NextApiRequest;
  await wrap((_req, r) => { answer.handlerRan = true; r.status(200).json({ success: true }); })(req, res);
  return answer;
}

const WRAPPERS: Array<[string, Wrapper]> = [
  ['withAuth', withAuth as unknown as Wrapper],
  ['withUserAuth', withUserAuth as unknown as Wrapper],
  ['withPlatformAdmin', withPlatformAdmin as unknown as Wrapper],
];

/** A fetch that never answers; it settles only when the caller's signal aborts. */
function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    // An unbounded call (no signal) would hang the request for good; fail fast
    // instead so the run reports it rather than stalling until the test timeout.
    if (!signal) { reject(new Error('unbounded GoTrue call: no abort signal')); return; }
    signal.addEventListener('abort', () => reject(signal.reason));
  }));
}

const OUTAGES: Array<[string, () => ReturnType<typeof vi.fn>]> = [
  ['GoTrue 500', () => vi.fn(async () => new Response('{"code":500,"msg":"53300"}', { status: 500 }))],
  ['GoTrue 502', () => vi.fn(async () => new Response('', { status: 502 }))],
  ['GoTrue 503', () => vi.fn(async () => new Response('', { status: 503 }))],
  ['GoTrue 408 (request timeout)', () => vi.fn(async () => new Response('', { status: 408 }))],
  ['GoTrue 429 (throttled)', () => vi.fn(async () => new Response('{"msg":"rate limit"}', { status: 429 }))],
  ['a network error', () => vi.fn(async () => { throw new TypeError('fetch failed'); })],
  ['a timeout', hangingFetch],
  ['a 200 whose body is cut off mid-read', () => vi.fn(async () => new Response(
    new ReadableStream({ start(c) { c.error(new TypeError('terminated')); } }), { status: 200 }))],
];

let restoreBound: () => void;
beforeEach(() => {
  vi.stubEnv('JWT_SECRET', SIGNING_KEY);
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-anon');
  // The auth pool is built from DATABASE_URL on first use. GitHub's unit job sets it to an EMPTY string, which
  // beats vitest's dummy, so the test names its own: the mocked Pool never connects anywhere.
  vi.stubEnv('DATABASE_URL', 'postgres://127.0.0.1:1/x');
  restoreBound = setAuthUpstreamBoundForTests(50);
});
afterEach(() => { restoreBound(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe.each(WRAPPERS)('%s — auth provider outage vs rejection', (_name, wrap) => {
  it.each(OUTAGES)('%s → 503 + Retry-After, cookies untouched, handler never runs', async (_label, makeFetch) => {
    const fetch = makeFetch();
    vi.stubGlobal('fetch', fetch);
    const answer = await call(wrap);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(answer.status).toBe(503);
    expect(answer.headers['retry-after']).toBe('5');
    expect(answer.headers['set-cookie']).toBeUndefined();
    expect(answer.body).toMatchObject({ success: false, error: { code: 'AUTH_UNAVAILABLE' } });
    expect(answer.handlerRan).toBe(false);
  });

  it.each([401, 403])('GoTrue %i → 401 INVALID_TOKEN and the cookies are cleared', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"msg":"invalid JWT"}', { status })));
    const answer = await call(wrap);
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ error: { code: 'INVALID_TOKEN' } });
    const cleared = answer.headers['set-cookie'] as string[] | undefined;
    expect(cleared?.some((c) => c.startsWith(`${ACCESS_COOKIE}=;`))).toBe(true);
    expect(answer.headers['retry-after']).toBeUndefined();
    expect(answer.handlerRan).toBe(false);
  });

  it('a valid unenrolled session passes the gate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: USER, factors: [] })));
    const outcome = await call(wrap).then((a) => a, (err: Error) => err);
    // withAuth and withPlatformAdmin reach their pool next; withUserAuth runs the handler.
    if (outcome instanceof Error) expect(outcome.message).toBe(CONNECT_SENTINEL);
    else expect(outcome).toMatchObject({ status: 200, handlerRan: true });
  });
});

describe('the GoTrue call is bounded', () => {
  it('passes an abort signal, and a hung provider is answered within the bound', async () => {
    const fetch = hangingFetch();
    vi.stubGlobal('fetch', fetch);
    const started = Date.now();
    const answer = await call(withAuth as unknown as Wrapper);
    expect(answer.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
  });
});
