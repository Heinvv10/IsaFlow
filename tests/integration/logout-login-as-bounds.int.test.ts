/**
 * #1371 review M1 (WP9): Sign Out is unauthenticated, so its Login-as look-up must never hold or wait long for a
 * platform_admin slot, and the route is rate limited as /api/auth/refresh is. Whatever happens, the cookies clear.
 *
 * - the platform_admin pool is exhausted: the look-up gives up after BOUNDED_LOOKUP_CHECKOUT_MS, Sign Out still
 *   revokes the session at GoTrue and clears the cookies, and the late checkout is handed straight back;
 * - impersonation_sessions is locked: the SELECT is cancelled by its statement_timeout (BOUNDED_LOOKUP_STATEMENT_MS);
 * - over 30 a minute from one IP: 429, the cookies still clear, GoTrue and the look-up are not touched.
 *
 * GoTrue is the r-032 fake (global fetch). Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import logoutRoute from '../../pages/api/auth/logout';
import { getPlatformAdminPool } from '@/lib/auth/withPlatformAdmin.pools';
import { BOUNDED_LOOKUP_CHECKOUT_MS, BOUNDED_LOOKUP_STATEMENT_MS } from '@/lib/auth/impersonationSessions';
import { clearRateLimitCache } from '@/lib/rateLimit';
import { log } from '@/lib/logger';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture, type Jar } from './r-032-login-as.helpers';

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
afterAll(async () => {
  try {
    await pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'auth-logout:%'");
  } finally { await fx.tearDown(); await pool.end(); }
});
beforeEach(async () => {
  logouts.length = 0;
  await pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'auth-logout:%'");
  clearRateLimitCache();
});

async function signOut(jar: Jar) {
  const result = response();
  const t0 = Date.now();
  await (logoutRoute as (q: never, s: never) => Promise<unknown>)(request(jar, 'POST') as never, result.res as never);
  const cookies = (result.headers.get('set-cookie') as string[] | undefined) ?? [];
  return { status: result.state.statusCode, ms: Date.now() - t0,
    clearedAccess: cookies.some((c) => c.startsWith('sb-access-token=;') && /Max-Age=0/.test(c)) };
}

describe('M1: Sign Out never waits on the platform_admin pool', () => {
  it('the pool is exhausted: gives up within the checkout bound, still revokes and clears, hands the slot back', async () => {
    const jar = await fx.loginAsTarget();
    const admin = getPlatformAdminPool();
    const held: PoolClient[] = [];
    try {
      while (admin.totalCount < (admin.options.max ?? 10) || admin.idleCount > 0) held.push(await admin.connect());
      const r = await signOut(jar);
      expect(r).toMatchObject({ status: 200, clearedAccess: true });
      expect(r.ms).toBeGreaterThanOrEqual(BOUNDED_LOOKUP_CHECKOUT_MS - 50);
      expect(r.ms).toBeLessThan(BOUNDED_LOOKUP_CHECKOUT_MS + 3000);
      expect(logouts).toHaveLength(1);
    } finally {
      for (const c of held) c.release();
    }
    // The checkout that arrived after the bound was released at once: nothing is left checked out.
    await vi.waitFor(() => expect({ waiting: admin.waitingCount, inUse: admin.totalCount - admin.idleCount })
      .toEqual({ waiting: 0, inUse: 0 }));
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

  it('over 30 a minute from one IP: 429, cookies still cleared, GoTrue not called', async () => {
    const own = await fx.ownSession();
    for (let i = 0; i < 30; i += 1) expect((await signOut(own)).status).toBe(200);
    logouts.length = 0;
    const r = await signOut(own);
    expect(r).toMatchObject({ status: 429, clearedAccess: true });
    expect(logouts).toEqual([]);
  });
});
