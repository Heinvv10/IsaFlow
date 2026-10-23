// tests/integration/s07c-impersonate-stash-cleanup.int.test.ts
//
// S-07c moved the admin's token stash onto the migration_admin pool (migration
// 930), so it commits on its own instead of with withPlatformAdmin's
// transaction. A "Login as" that fails after the stash is written must still
// leave none behind: before, the rollback removed it; now the route deletes it.
// admin-rollback-impersonate.int.test.ts asserts the same end to end, but only
// with a live GoTrue; this one fakes GoTrue (r-032 fixture) and always runs.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import startImpersonation from '../../pages/api/admin/users/[id]/impersonate';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture } from './r-032-login-as.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

const failCookieStep = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/auth/impersonation-cookies', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/impersonation-cookies')>();
  return {
    ...actual,
    setImpersonationCookies: (...args: Parameters<typeof actual.setImpersonationCookies>) => {
      if (failCookieStep.on) throw new Error('s07c: impersonation cookie step failed');
      return actual.setImpersonationCookies(...args);
    },
  };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const fx = loginAsFixture(pool, 'S07c stash');

beforeAll(() => fx.setUp(), 60000);
afterAll(async () => { await fx.tearDown(); await pool.end(); });

const stashes = async () =>
  (await pool.query('SELECT count(*)::int AS n FROM admin_impersonation_stash WHERE admin_user_id = $1', [fx.platformAdmin])).rows[0].n;

async function start() {
  const jar = { 'sb-access-token': await signSession(fx.platformAdmin, crypto.randomUUID(), 'aal2'), 'sb-refresh-token': 'admin-refresh' };
  const result = response();
  await startImpersonation(request(jar, 'POST', fx.target), result.res);
  return result.state.statusCode;
}

describe('S-07c: a Login-as that fails after the stash is written leaves no stash', () => {
  it('the cookie step throws: 500, and the stash is gone', async () => {
    failCookieStep.on = true;
    try {
      expect(await start()).toBe(500);
    } finally {
      failCookieStep.on = false;
    }
    expect(await stashes()).toBe(0);
  });

  it('the same start without the failure keeps its stash (the cleanup is not unconditional)', async () => {
    expect(await start()).toBe(200);
    expect(await stashes()).toBe(1);
  });
});
