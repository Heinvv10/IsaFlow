/**
 * #1371 review M1 / re-break N1, N3 (WP9): Sign Out and end-impersonation are reachable without a live session, so
 * their Login-as look-up must never hold or wait long for a platform_admin slot. Whatever happens, the cookies clear.
 *
 * - the platform_admin pool is exhausted: the look-up gives up after BOUNDED_LOOKUP_CHECKOUT_MS, Sign Out still
 *   revokes the session at GoTrue and clears the cookies, and the late checkout is handed straight back;
 * - impersonation_sessions is locked: the SELECT is cancelled by its statement_timeout (BOUNDED_LOOKUP_STATEMENT_MS);
 * - Sign Out is NOT rate limited (N1: a per-IP bucket behind cloudflared let one script block everyone's
 *   revocation): 40 rapid Sign Outs all revoke;
 * - end-impersonation with the pool exhausted answers within the bound: an expired stash is refused with the
 *   cookies cleared, a live one gets a retryable 503 with the cookies kept.
 *
 * GoTrue is the r-032 fake (global fetch). Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { decodeJwt } from 'jose';
import logoutRoute, { SIGN_OUT_LOOKUP_SLOTS } from '../../pages/api/auth/logout';
import endImpersonation from '../../pages/api/auth/end-impersonation';
import { getPlatformAdminPool } from '@/lib/auth/withPlatformAdmin.pools';
import { BOUNDED_LOOKUP_CHECKOUT_MS, BOUNDED_LOOKUP_STATEMENT_MS } from '@/lib/auth/impersonationSessions';
import { log } from '@/lib/logger';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture, type Jar } from './r-032-login-as.helpers';

/** Counts concurrent Sign Out look-ups at the module boundary; `delayMs` holds each so a burst overlaps. */
const lookups = vi.hoisted(() => ({ delayMs: 0, inFlight: 0, maxInFlight: 0, calls: 0 }));
vi.mock('@/lib/auth/impersonationSessions', async (orig) => {
  const real = await orig<typeof import('@/lib/auth/impersonationSessions')>();
  return {
    ...real,
    impersonationPartiesOfBounded: async (sessionId: string) => {
      lookups.calls += 1;
      lookups.inFlight += 1;
      lookups.maxInFlight = Math.max(lookups.maxInFlight, lookups.inFlight);
      try {
        if (lookups.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, lookups.delayMs));
        return await real.impersonationPartiesOfBounded(sessionId);
      } finally { lookups.inFlight -= 1; }
    },
  };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const fx = loginAsFixture(pool, 'WP9 logout bounds');
const logouts: string[] = [];

beforeAll(async () => {
  await fx.setUp();
  const fake = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).includes('/logout')) logouts.push(String(input));
    return fake(input, init);
  });
}, 60000);
afterAll(async () => { await fx.tearDown(); await pool.end(); });
beforeEach(() => { logouts.length = 0; Object.assign(lookups, { delayMs: 0, inFlight: 0, maxInFlight: 0, calls: 0 }); });

async function post(route: unknown, jar: Jar) {
  const result = response();
  const t0 = Date.now();
  await (route as (q: never, s: never) => Promise<unknown>)(request(jar, 'POST') as never, result.res as never);
  const cookies = (result.headers.get('set-cookie') as string[] | undefined) ?? [];
  return { status: result.state.statusCode, ms: Date.now() - t0,
    clearedAccess: cookies.some((c) => c.startsWith('sb-access-token=;') && /Max-Age=0/.test(c)),
    clearedStash: cookies.some((c) => c.startsWith('sb-admin-stash=;') && /Max-Age=0/.test(c)) };
}
const signOut = (jar: Jar) => post(logoutRoute, jar);

/** Holds every platform_admin pool connection while `fn` runs; checks nothing stays checked out afterwards. */
async function withPoolExhausted<T>(fn: () => Promise<T>): Promise<T> {
  const admin = getPlatformAdminPool();
  const held: PoolClient[] = [];
  let out: T;
  try {
    while (admin.totalCount < (admin.options.max ?? 10) || admin.idleCount > 0) held.push(await admin.connect());
    out = await fn();
  } finally {
    for (const c of held) c.release();
  }
  // The checkout that arrived after the bound was released at once: nothing is left checked out.
  await vi.waitFor(() => expect({ waiting: admin.waitingCount, inUse: admin.totalCount - admin.idleCount })
    .toEqual({ waiting: 0, inUse: 0 }));
  return out;
}

describe('M1: Sign Out never waits on the platform_admin pool', () => {
  it('the pool is exhausted: gives up within the checkout bound, still revokes and clears, hands the slot back', async () => {
    const jar = await fx.loginAsTarget();
    const r = await withPoolExhausted(() => signOut(jar));
    expect(r).toMatchObject({ status: 200, clearedAccess: true });
    expect(r.ms).toBeGreaterThanOrEqual(BOUNDED_LOOKUP_CHECKOUT_MS - 50);
    expect(r.ms).toBeLessThan(BOUNDED_LOOKUP_CHECKOUT_MS + 3000);
    expect(logouts).toHaveLength(1);
  });

  it('impersonation_sessions is locked: the look-up is cancelled by its statement_timeout, Sign Out completes', async () => {
    const jar = await fx.loginAsTarget();
    const locker = await pool.connect();
    const warn = vi.spyOn(log, 'warn');
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE impersonation_sessions IN ACCESS EXCLUSIVE MODE');
      const r = await signOut(jar);
      expect(r).toMatchObject({ status: 200, clearedAccess: true });
      expect(r.ms).toBeGreaterThanOrEqual(BOUNDED_LOOKUP_STATEMENT_MS - 50);
      expect(r.ms).toBeLessThan(BOUNDED_LOOKUP_STATEMENT_MS + 3000);
      expect(logouts).toHaveLength(1);
      // The server's statement_timeout cancelled it, not the slower client-side query_timeout backstop.
      expect(warn.mock.calls.some(([, data]) => /statement timeout/.test(String((data as { message?: unknown })?.message))))
        .toBe(true);
    } finally {
      warn.mockRestore();
      await locker.query('ROLLBACK');
      locker.release();
    }
  });

  it('N1 not rate limited: 40 rapid Sign Outs from one IP all revoke their session', async () => {
    const sessions = await Promise.all(Array.from({ length: 40 }, () => fx.ownSession()));
    const results = await Promise.all(sessions.map((jar) => signOut(jar)));
    expect(results.every((r) => r.status === 200 && r.clearedAccess)).toBe(true);
    expect(logouts).toHaveLength(40);
  });
});

describe('security review: Sign Out look-ups are capped process-wide', () => {
  it('20 concurrent Sign Outs never run more than SIGN_OUT_LOOKUP_SLOTS look-ups or hold more slots; all revoke', async () => {
    const admin = getPlatformAdminPool();
    // Each could be a Login-as (a stash cookie and a verifying token with a session id), so each wants a slot.
    const sessions = (await Promise.all(Array.from({ length: 20 }, () => fx.ownSession())))
      .map((jar) => ({ ...jar, 'sb-admin-stash': crypto.randomUUID() }));
    lookups.delayMs = 200;
    let maxInUse = 0;
    const sampler = setInterval(() => { maxInUse = Math.max(maxInUse, admin.totalCount - admin.idleCount); }, 5);
    try {
      const results = await Promise.all(sessions.map((jar) => signOut(jar)));
      expect(results.every((r) => r.status === 200 && r.clearedAccess)).toBe(true);
    } finally { clearInterval(sampler); }
    expect(logouts).toHaveLength(20); // every one revoked at GoTrue, over the cap or not
    expect(lookups.calls).toBeGreaterThan(0);
    expect(lookups.maxInFlight).toBeLessThanOrEqual(SIGN_OUT_LOOKUP_SLOTS);
    expect(maxInUse).toBeLessThanOrEqual(SIGN_OUT_LOOKUP_SLOTS);
  });
});

describe('security review: only a possible Login-as takes a look-up slot', () => {
  it('50 token-less, junk-token and stash-less Sign Outs do not stop a real Login-as Sign Out closing its stash', async () => {
    const real = await fx.loginAsTarget();
    const own = await fx.ownSession();
    const noise: Jar[] = Array.from({ length: 50 }, (_, i) => (
      i % 3 === 0 ? { 'sb-admin-stash': crypto.randomUUID() } // no access token
        : i % 3 === 1 ? { 'sb-access-token': `junk-${i}`, 'sb-admin-stash': crypto.randomUUID() } // does not verify
          : { ...own })); // a verifying token, no stash cookie
    lookups.delayMs = 200;
    const results = await Promise.all([...noise.map((jar) => signOut(jar)), signOut(real)]);
    expect(results.every((r) => r.status === 200 && r.clearedAccess)).toBe(true);
    expect(lookups.calls).toBe(1); // only the real Login-as took a slot
    expect((await pool.query('SELECT count(*)::int AS n FROM admin_impersonation_stash WHERE stash_id = $1',
      [real['sb-admin-stash']])).rows[0].n).toBe(0);
    const [end] = (await pool.query(`SELECT details FROM admin_audit_log WHERE admin_user_id = $1
      AND action = 'impersonation_end' ORDER BY created_at DESC LIMIT 1`, [fx.platformAdmin])).rows;
    expect(end.details).toMatchObject({ reason: 'logout', target_session_revoked: true });
  });
});

describe('re-break M1: one session holds at most one look-up slot', () => {
  it('40 Sign Outs from one attacker session (a stash cookie, not a Login-as) do not starve the victim', async () => {
    const victim = await fx.loginAsTarget();
    const attacker = { ...(await fx.ownSession()), 'sb-admin-stash': crypto.randomUUID() };
    lookups.delayMs = 200;
    const burst = Array.from({ length: 40 }, () => signOut(attacker));
    burst.splice(20, 0, signOut(victim));
    const results = await Promise.all(burst);
    expect(results.every((r) => r.status === 200 && r.clearedAccess)).toBe(true);
    expect(lookups.maxInFlight).toBeLessThanOrEqual(2);
    const sid = String(decodeJwt(victim['sb-access-token']!).session_id);
    const rows = (await pool.query(`SELECT details FROM admin_audit_log WHERE admin_user_id = $1
      AND action = 'impersonation_end' AND details->>'session_id' = $2`, [fx.platformAdmin, sid])).rows;
    expect(rows).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM admin_impersonation_stash WHERE stash_id = $1',
      [victim['sb-admin-stash']])).rows[0].n).toBe(0);
  });
});

describe('N3: end-impersonation never waits on the platform_admin pool', () => {
  it('an expired stash with the pool exhausted: refused within the bound, cookies cleared', async () => {
    const jar = await fx.loginAsTarget();
    await pool.query(`UPDATE admin_impersonation_stash SET expires_at = now() - interval '1 second' WHERE stash_id = $1`,
      [jar['sb-admin-stash']]);
    const r = await withPoolExhausted(() => post(endImpersonation, jar));
    expect(r).toMatchObject({ status: 401, clearedAccess: true, clearedStash: true });
    expect(r.ms).toBeLessThan(4000);
  });

  it('a live stash with the pool exhausted: a retryable 503 within the bound, cookies kept; the retry restores', async () => {
    const jar = await fx.loginAsTarget();
    const r = await withPoolExhausted(() => post(endImpersonation, jar));
    expect(r).toMatchObject({ status: 503, clearedAccess: false, clearedStash: false });
    expect(r.ms).toBeLessThan(4000);
    expect(logouts).toEqual([]);
    expect((await post(endImpersonation, jar)).status).toBe(200);
  });
});
