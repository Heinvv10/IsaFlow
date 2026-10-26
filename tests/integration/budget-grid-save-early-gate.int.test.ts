/**
 * The early-read gate of `withBodyFirst` (round 4): a body is read before withAuth only for a
 * caller who passes the same token checks withAuth's verifyToken makes (signature, expiry, and
 * aal2 unless GoTrue confirms no MFA factor is enrolled), and at most two early reads per user are
 * in flight; a third is 429 with Retry-After, its body not read; another user is unaffected. Before
 * the read, the user's save bucket is charged (429 when full) and the process's early-read bytes
 * are capped (503). A request withAuth admits that was not read early is refused, never read
 * inside the transaction. Every "not read" is shown by the body never being released: the answer
 * comes while the bytes are still withheld, and no wall-clock bound is asserted.
 * GoTrue's /user is stubbed per test (fetch); everything else is the real route on PostgreSQL.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { Readable } from 'node:stream';
import { SignJWT, decodeJwt } from 'jose';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { earlyReadStats } from '@/lib/readJsonBody';
import { clearRateLimitCache } from '@/lib/rateLimit';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type GridCo } from './helpers/budgetGridFixture';
import { TOKEN_SQL } from './helpers/budgetGridSaveFixture';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = budgetGridFixture(pool);
const FY27 = monthsFrom('2026-03');
let A: GridCo, B: GridCo, C: GridCo;

beforeAll(async () => { A = await fx.company(); B = await fx.company(); C = await fx.company(); }, 120000);
afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } }, 120000);
// A stalled body is refused after 1 s, not the route's 5 s (readJsonBody honours this under Vitest only).
beforeEach(() => { vi.stubEnv('BODY_READ_IDLE_MS', '1000'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** GoTrue's /user answers with these factors for any bearer (the real call withAuth makes for an aal1 token). */
function stubGotrueFactors(factors: Array<{ status: string }>, failFirst = 0) {
  vi.stubEnv('SUPABASE_ANON_KEY', 'test-anon-key');
  let calls = 0;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls += 1;
    if (calls <= failFirst) throw new Error('GoTrue unreachable (stub)');
    const bearer = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!String(input).endsWith('/user')) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ id: decodeJwt(bearer).sub, factors }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

/** A body whose bytes are withheld until `release()`; `pulled` counts what the route took. */
function withheld(json: Buffer) {
  const seen = { pulled: 0 };
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  const stream = Readable.from((async function* gen() { await released; seen.pulled += json.length; yield json; })());
  return { stream, seen, release };
}

/** POSTs `stream` to the save as `token` in `c`; resolves with status, body, headers and how long it took. */
async function post(c: GridCo, token: string, stream: Readable, length: number) {
  const base = request({ 'sb-access-token': token, active_company_id: c.id }, 'POST') as unknown as { headers: Record<string, string> };
  const req = Object.assign(stream, base, {
    url: '/api/accounting/budget-grid/save', query: {},
    headers: { ...base.headers, 'content-type': 'application/json', 'content-length': String(length) },
  });
  const out = response();
  const t0 = Date.now();
  await (saveRoute as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  return { status: out.state.statusCode, body: out.state.body as { error?: { code?: string } }, retryAfter: out.headers.get('retry-after'), ms: Date.now() - t0 };
}

async function saveBody(c: GridCo, month: string) {
  const v = await fx.version(c);
  const t = String((await pool.query(`SELECT ${TOKEN_SQL} t FROM budget_versions WHERE id = $1`, [v])).rows[0].t);
  return Buffer.from(JSON.stringify({ versionId: v, expectedUpdatedAt: t, cells: [{ glAccountId: c.acct.rent, cc1Id: null, cc2Id: null, buId: null, month, amount: 5 }] }));
}

describe('withBodyFirst: who is read early', () => {
  it('an aal1 token of a user with a verified MFA factor is refused at once, its body never read', async () => {
    stubGotrueFactors([{ status: 'verified' }]);
    const aal1 = await signSession(A.owner.userId, undefined, 'aal1');
    const json = await saveBody(A, FY27[0]!);
    const { stream, seen, release } = withheld(json);
    const r = await post(A, aal1, stream, json.length);
    release();
    expect([r.status, seen.pulled], JSON.stringify(r)).toEqual([401, 0]);
  });

  it('an expired aal2 token is refused at once, its body never read', async () => {
    const expired = await new SignJWT({ role: 'authenticated', aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setSubject(A.owner.userId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const json = await saveBody(A, FY27[0]!);
    const { stream, seen, release } = withheld(json);
    const r = await post(A, expired, stream, json.length);
    release();
    expect([r.status, seen.pulled], JSON.stringify(r)).toEqual([401, 0]);
  });

  it('an aal1 token of a user with no MFA enrolled (withAuth accepts it) is read early and saves', async () => {
    stubGotrueFactors([]);
    const aal1 = await signSession(A.owner.userId, undefined, 'aal1');
    const json = await saveBody(A, FY27[1]!);
    const { stream, release } = withheld(json);
    const pending = post(A, aal1, stream, json.length);
    release();
    expect((await pending).status).toBe(200);
  });
});

describe('withBodyFirst: early reads per user', () => {
  it('a third concurrent upload from one user is 429 with Retry-After, unread; another user is unaffected', async () => {
    vi.stubEnv('BODY_READ_IDLE_MS', '30000'); // the two held uploads must outlast the rest of the test
    const bodies = await Promise.all([saveBody(A, FY27[2]!), saveBody(A, FY27[3]!), saveBody(A, FY27[4]!), saveBody(B, FY27[2]!)]);
    const [a1, a2, a3, b1] = bodies.map(withheld);
    const first = post(A, A.owner.token, a1!.stream, bodies[0]!.length);
    const second = post(A, A.owner.token, a2!.stream, bodies[1]!.length);
    await new Promise((r) => setTimeout(r, 200));
    const third = await post(A, A.owner.token, a3!.stream, bodies[2]!.length);
    a3!.release();
    expect([third.status, third.body.error?.code, third.retryAfter, a3!.seen.pulled], JSON.stringify(third))
      .toEqual([429, 'RATE_LIMIT', '5', 0]);
    // Another user still gets an early read while A has two in flight.
    const other = post(B, B.owner.token, b1!.stream, bodies[3]!.length);
    b1!.release();
    expect((await other).status).toBe(200);
    a1!.release();
    a2!.release();
    expect([(await first).status, (await second).status]).toEqual([200, 200]);
    // The slots are given back: a further upload from A is read again.
    const json = await saveBody(A, FY27[5]!);
    const again = withheld(json);
    const later = post(A, A.owner.token, again.stream, json.length);
    again.release();
    expect((await later).status).toBe(200);
  });
});

describe('withBodyFirst: what bounds the reads', () => {
  it("a request withAuth admits that was not read early (GoTrue failed once) is refused REQUEST_BODY_NOT_READ, never read in the transaction", async () => {
    // The gate's GoTrue call fails, withAuth's succeeds: the handler runs with no early bytes.
    stubGotrueFactors([], 1);
    const aal1 = await signSession(A.owner.userId, undefined, 'aal1');
    const json = await saveBody(A, FY27[6]!);
    const { stream, seen, release } = withheld(json);
    const r = await post(A, aal1, stream, json.length);
    release();
    expect([r.status, (r.body.error as { details?: { code?: string } } | undefined)?.details?.code, seen.pulled], JSON.stringify(r))
      .toEqual([400, 'REQUEST_BODY_NOT_READ', 0]);
  });

  it("a user whose save bucket is full is 429 with Retry-After 60 before the body is read", async () => {
    const key = `budget-save:${C.owner.userId}`;
    await pool.query(`INSERT INTO rate_limit_counters (key, count, window_start) VALUES ($1, 120, now())
                      ON CONFLICT (key) DO UPDATE SET count = 120, window_start = now()`, [key]);
    try {
      const json = await saveBody(C, FY27[7]!);
      const { stream, seen, release } = withheld(json);
      const r = await post(C, C.owner.token, stream, json.length);
      release();
      expect([r.status, r.body.error?.code, r.retryAfter, seen.pulled], JSON.stringify(r)).toEqual([429, 'RATE_LIMIT', '60', 0]);
    } finally {
      await pool.query('DELETE FROM rate_limit_counters WHERE key = $1', [key]);
      clearRateLimitCache(); // the limiter remembers a full bucket for a few seconds
    }
  });

  it('early reads past 64 MB in flight in the process are 503 with Retry-After, unread; the bytes are given back', async () => {
    // Three users each declare a 24 MB body (the save's cap) and send nothing: 72 MB > 64 MB.
    const big = String(24 * 1048576);
    const [x, y, z] = [withheld(Buffer.from('{}')), withheld(Buffer.from('{}')), withheld(Buffer.from('{}'))];
    const first = post(A, A.owner.token, x.stream, Number(big));
    const second = post(B, B.owner.token, y.stream, Number(big));
    for (let i = 0; i < 100 && earlyReadStats().reads < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(earlyReadStats()).toEqual({ reads: 2, bytes: 48 * 1048576 });
    const third = await post(C, C.owner.token, z.stream, Number(big));
    expect([third.status, third.body.error?.code, third.retryAfter, z.seen.pulled], JSON.stringify(third)).toEqual([503, 'SERVICE_UNAVAILABLE', '5', 0]);
    // The two withheld bodies run into the 1 s idle bound, and their reservations are released.
    expect([(await first).status, (await second).status]).toEqual([400, 400]);
    x.release(); y.release(); z.release();
    expect(earlyReadStats()).toEqual({ reads: 0, bytes: 0 });
  });
});
