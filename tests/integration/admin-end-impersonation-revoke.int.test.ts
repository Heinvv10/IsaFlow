/**
 * Admin audit 2026-11-14 item 3.10 (WP9): ending a Login-as ends it at GoTrue too, and leaves no stash behind.
 *
 * - "Return to my session" (end-impersonation) revokes the target session the Login-as minted (GoTrue
 *   /logout?scope=local with that session's own token), so a copy of its refresh token dies with it. It used to
 *   restore the admin and leave the target session live at GoTrue. A failed revocation does not trap the admin in
 *   the target's session: the end goes ahead and its audit row records `target_session_revoked: false`.
 * - Sign Out from a Login-as session (/api/auth/logout) removes the stash row too (it cleared only the cookie), by
 *   the parties on the session record, and records the end.
 * - Expired stash rows (encrypted admin tokens) are purged on the start and end paths; nothing else ever did.
 * - Every way out of end-impersonation ends the Login-as with the `impersonation_end` row written FIRST: a failed
 *   write is a failure with nothing irreversible done (no revocation, no stash removed, no Set-Cookie). A refused
 *   Return (no access cookie, an expired stash) still revokes what it holds, removes the stash and audits.
 *
 * GoTrue is the r-032 fake (module boundary: global fetch), so this always runs. Tokens are aal2.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import endImpersonation from '../../pages/api/auth/end-impersonation';
import logoutRoute from '../../pages/api/auth/logout';
import startImpersonation from '../../pages/api/admin/users/[id]/impersonate';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture, type Jar } from './r-032-login-as.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const fx = loginAsFixture(pool, 'WP9 end Login-as');

/** Every GoTrue /logout call, with the bearer it carried; `failLogout` makes GoTrue refuse it. */
const logouts: { path: string; bearer: string }[] = [];
/** How many of this admin's stash rows existed at each GoTrue /logout (review L2: the stash goes BEFORE the revoke). */
const stashesAtLogout: number[] = [];
let failLogout = false;

beforeAll(async () => {
  await fx.setUp();
  const fake = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.includes('/logout')) {
      logouts.push({ path: url.slice(url.indexOf('/logout')),
        bearer: new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '' });
      stashesAtLogout.push((await pool.query(
        'SELECT count(*)::int AS n FROM admin_impersonation_stash WHERE admin_user_id = $1', [fx.platformAdmin])).rows[0].n);
      if (failLogout) return new Response('{"msg":"wp9: logout refused"}', { status: 500 });
    }
    return fake(input, init);
  });
}, 60000);
afterAll(async () => {
  try { await pool.query('ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS wp9_block_end_audit'); }
  finally { await fx.tearDown(); await pool.end(); }
});
beforeEach(() => { logouts.length = 0; stashesAtLogout.length = 0; failLogout = false; });
afterEach(async () => {
  await pool.query('ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS wp9_block_end_audit');
  await pool.query('DELETE FROM admin_impersonation_stash WHERE admin_user_id = $1', [fx.platformAdmin]);
});

const stashes = async () => (await pool.query(
  'SELECT stash_id::text AS id FROM admin_impersonation_stash WHERE admin_user_id = $1', [fx.platformAdmin])).rows
  .map((r) => r.id as string);
const plantExpiredStash = async () => (await pool.query(
  `INSERT INTO admin_impersonation_stash (admin_user_id, admin_access_token, admin_refresh_token, target_user_id, expires_at)
   VALUES ($1, 'expired-a', 'expired-r', $2, now() - interval '1 minute') RETURNING stash_id::text AS id`,
  [fx.platformAdmin, fx.target])).rows[0].id as string;
const ends = async () => (await pool.query(
  `SELECT details FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'impersonation_end' ORDER BY created_at`,
  [fx.platformAdmin])).rows.map((r) => r.details as Record<string, unknown>);

async function post(handler: unknown, jar: Jar) {
  const result = response();
  let threw = false;
  try {
    await (handler as (q: never, s: never) => Promise<unknown>)(request(jar, 'POST') as never, result.res as never);
  } catch { threw = true; /* the route has no error wrapper: a throw is Next's 500 */ }
  const cookies = ((result.headers.get('set-cookie') as string[] | undefined) ?? []);
  return { ...result.state, threw, cookies,
    stashCookieCleared: cookies.some((c) => c.startsWith('sb-admin-stash=;') && /Max-Age=0/.test(c)) };
}
const blockEndAudit = () => pool.query(`ALTER TABLE admin_audit_log ADD CONSTRAINT wp9_block_end_audit
  CHECK (action <> 'impersonation_end' OR admin_user_id <> '${fx.platformAdmin}') NOT VALID`);

describe('3.10: ending a Login-as', () => {
  it('Return to my session revokes the Login-as session at GoTrue and removes its stash', async () => {
    const jar = await fx.loginAsTarget();
    const r = await post(endImpersonation, jar);
    expect(r.statusCode).toBe(200);
    expect(r.stashCookieCleared).toBe(true);
    expect(logouts).toEqual([{ path: '/logout?scope=local', bearer: jar['sb-access-token'] }]);
    expect(stashesAtLogout).toEqual([0]); // deleted before the revocation, so a retry cannot restore twice
    expect(await stashes()).toEqual([]);
    expect((await ends()).at(-1)).toMatchObject({ target_session_revoked: true });
  });

  it('GoTrue refuses the revocation: the admin still gets back, the stash still goes, the audit row says so', async () => {
    const jar = await fx.loginAsTarget();
    failLogout = true;
    const r = await post(endImpersonation, jar);
    expect(r.statusCode).toBe(200);
    expect(logouts).toHaveLength(1);
    expect(await stashes()).toEqual([]);
    expect((await ends()).at(-1)).toMatchObject({ target_session_revoked: false });
  });

  it('Sign Out from a Login-as session removes its stash row and records the end', async () => {
    const jar = await fx.loginAsTarget();
    expect(await stashes()).toHaveLength(1);
    const r = await post(logoutRoute, jar);
    expect(r.statusCode).toBe(200);
    expect(r.stashCookieCleared).toBe(true);
    expect(logouts.map((l) => l.bearer)).toEqual([jar['sb-access-token']]);
    expect(await stashes()).toEqual([]);
    expect((await ends()).at(-1)).toMatchObject({ reason: 'logout' });
  });

  it('B4 Sign Out while GoTrue is down: the stash still goes, and the end row says the session was NOT revoked', async () => {
    const jar = await fx.loginAsTarget();
    failLogout = true;
    const r = await post(logoutRoute, { ...jar, 'sb-refresh-token': 'refresh-x' });
    expect(r.statusCode).toBe(200);
    expect(await stashes()).toEqual([]);
    expect((await ends()).at(-1)).toMatchObject({ reason: 'logout', target_session_revoked: false });
  });

  it('Sign Out from an ordinary session touches no stash', async () => {
    const live = await fx.loginAsTarget();
    const own = await fx.ownSession();
    expect((await post(logoutRoute, own)).statusCode).toBe(200);
    expect(await stashes()).toEqual([live['sb-admin-stash']]);
    await post(endImpersonation, live);
  });
});

describe('3.10: a refused or failed Return still ends the Login-as, audit first', () => {
  it('B1 the stash expired (STASH_EXPIRED): session revoked, stash row gone, end audited', async () => {
    const jar = await fx.loginAsTarget();
    await pool.query(`UPDATE admin_impersonation_stash SET expires_at = now() - interval '1 second' WHERE stash_id = $1`,
      [jar['sb-admin-stash']]);
    const before = (await ends()).length;
    const r = await post(endImpersonation, jar);
    expect(r.statusCode).toBe(401);
    expect(logouts.map((l) => l.bearer)).toEqual([jar['sb-access-token']]);
    expect(await stashes()).toEqual([]);
    expect((await ends()).slice(before)).toEqual([
      expect.objectContaining({ reason: 'stash_expired', target_session_revoked: true, stashes_removed: 1 }),
    ]);
  });

  it('N2 a stash id alone (no access cookie, or a bad token): cookies cleared; no stash removed, no end row written', async () => {
    const jar = await fx.loginAsTarget();
    const { 'sb-access-token': _gone, ...stashOnly } = jar;
    const before = (await ends()).length;
    for (const attempt of [stashOnly, { ...stashOnly, 'sb-access-token': 'not-a-jwt' }]) {
      const r = await post(endImpersonation, attempt);
      expect(r.statusCode).toBe(401);
      expect(r.stashCookieCleared).toBe(true);
    }
    expect(logouts).toEqual([]);
    expect(await stashes()).toEqual([jar['sb-admin-stash']]); // expires within 1 h; the next start or end purges it
    expect((await ends()).length).toBe(before);
  });

  it('B3b a retry after a lost answer reuses the end row: one row per stash, its reason unchanged', async () => {
    const jar = await fx.loginAsTarget();
    expect((await post(endImpersonation, jar)).statusCode).toBe(200);
    const retry = await post(endImpersonation, jar); // the browser never saw the 200: same cookies again
    expect(retry.statusCode).toBe(401); // STASH_EXPIRED: the stash went with the first end
    const rows = (await pool.query(
      `SELECT details FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'impersonation_end'
         AND details->>'stash_id' = $2`, [fx.platformAdmin, jar['sb-admin-stash']])).rows.map((r) => r.details);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('reason');
    expect(rows[0]).toMatchObject({ target_session_revoked: true });
  });

  it('B3 the end audit cannot be written: a failure, and nothing irreversible happened; a retry then works', async () => {
    const jar = await fx.loginAsTarget();
    await blockEndAudit();
    const r = await post(endImpersonation, jar);
    expect(r.threw).toBe(true);
    expect(logouts).toEqual([]);
    expect(r.cookies).toEqual([]);
    expect(await stashes()).toEqual([jar['sb-admin-stash']]);
    await pool.query('ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS wp9_block_end_audit');
    const retry = await post(endImpersonation, jar);
    expect(retry.statusCode).toBe(200);
    expect(await stashes()).toEqual([]);
  });

  it('B5 another super admin holding the stash cookie: refused, nothing revoked, stash kept, nothing audited', async () => {
    const jar = await fx.loginAsTarget();
    const other = crypto.randomUUID();
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [other, `${other}@test.local`]);
    try {
      const before = (await ends()).length;
      const r = await post(endImpersonation, { ...jar, 'sb-access-token': await signSession(other, crypto.randomUUID(), 'aal2') });
      expect(r.statusCode).toBe(403);
      expect(logouts).toEqual([]);
      expect(await stashes()).toEqual([jar['sb-admin-stash']]);
      expect((await ends()).length).toBe(before);
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [other]);
    }
  });
});

describe('3.10: expired stash rows are purged', () => {
  it('on the start path', async () => {
    const expired = await plantExpiredStash();
    const jar = { 'sb-access-token': await signSession(fx.platformAdmin, crypto.randomUUID(), 'aal2'), 'sb-refresh-token': 'admin-refresh' };
    const started = response();
    await startImpersonation(request(jar, 'POST', fx.target), started.res);
    expect(started.state.statusCode).toBe(200);
    const left = await stashes();
    expect(left).not.toContain(expired);
    expect(left).toHaveLength(1);
    await pool.query('DELETE FROM admin_impersonation_stash WHERE admin_user_id = $1', [fx.platformAdmin]);
  });

  it('on the end path', async () => {
    const jar = await fx.loginAsTarget();
    const expired = await plantExpiredStash();
    expect((await post(endImpersonation, jar)).statusCode).toBe(200);
    expect(await stashes()).not.toContain(expired);
    expect(await stashes()).toEqual([]);
  });
});
