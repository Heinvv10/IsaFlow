/**
 * The end of a Login-as session refused at /api/auth/refresh, against the real tables
 * and the real pools. The stash cookie is only a browser's say-so, so the rows removed
 * are chosen by the parties on the session record: the stash it named and any of theirs
 * already expired, never a newer live Login-as and never another admin's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { decodeJwt } from 'jose';
import { endExpiredLoginAs } from '@/lib/auth/endExpiredLoginAs';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture, type Jar } from './r-032-login-as.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = loginAsFixture(pool, 'Login-as end');
const other = loginAsFixture(pool, 'Login-as end other');

beforeAll(async () => {
  await fx.setUp();
  await other.setUp();
});
afterAll(async () => {
  try {
    await other.tearDown();
    await fx.tearDown();
  } finally { await pool.end(); }
});

const stashExists = async (id: string) =>
  (await pool.query('SELECT 1 FROM admin_impersonation_stash WHERE stash_id = $1::uuid', [id])).rowCount === 1;
const end = async (jar: Jar, stashId?: string) => {
  const result = response();
  await endExpiredLoginAs(result.res, jar['sb-access-token']!, stashId);
  return result;
};
const lastEnd = async () => (await pool.query(
  `SELECT admin_user_id, target_id, details FROM admin_audit_log
    WHERE admin_user_id = $1 AND action = 'impersonation_end' ORDER BY created_at DESC LIMIT 1`, [fx.platformAdmin])).rows[0];

describe('endExpiredLoginAs', () => {
  it('removes the named stash and expired ones, keeps a newer live one, and audits to the admin', async () => {
    const ended = await fx.loginAsTarget();
    const expired = await fx.loginAsTarget();
    const newer = await fx.loginAsTarget();
    // Expired only after the last start: a Login-as start purges every expired stash (admin audit 3.10).
    await pool.query(`UPDATE admin_impersonation_stash SET expires_at = NOW() - INTERVAL '1 minute' WHERE stash_id = $1::uuid`, [expired['sb-admin-stash']]);
    // Each fixture stubs fetch in setUp, so the last one set up records every GoTrue call.
    const callsBefore = other.gotrueCalls.length;

    await end(ended, ended['sb-admin-stash']);

    expect(await stashExists(ended['sb-admin-stash']!)).toBe(false);
    expect(await stashExists(expired['sb-admin-stash']!)).toBe(false);
    expect(await stashExists(newer['sb-admin-stash']!)).toBe(true);
    expect(other.gotrueCalls.slice(callsBefore)).toContain('POST /logout?scope=local');
    expect(await lastEnd()).toMatchObject({
      admin_user_id: fx.platformAdmin,
      target_id: decodeJwt(ended['sb-access-token']!).sub,
      details: { reason: 'proof_expired', stashes_removed: 2 },
    });
  });

  it('with the stash cookie gone, still removes what has expired', async () => {
    const jar = await fx.loginAsTarget();
    await pool.query(`UPDATE admin_impersonation_stash SET expires_at = NOW() - INTERVAL '1 minute' WHERE stash_id = $1::uuid`, [jar['sb-admin-stash']]);
    await end(jar);
    expect(await stashExists(jar['sb-admin-stash']!)).toBe(false);
  });

  it("a stash cookie naming another admin's stash removes nothing of theirs", async () => {
    const theirs = await other.loginAsTarget();
    const mine = await fx.loginAsTarget();
    await end(mine, theirs['sb-admin-stash']);
    expect(await stashExists(theirs['sb-admin-stash']!)).toBe(true);
  });

  it('a stash cookie that is not a uuid is harmless', async () => {
    const jar = await fx.loginAsTarget();
    await end(jar, 'not-a-uuid');
    expect(await stashExists(jar['sb-admin-stash']!)).toBe(true);
    expect((await lastEnd()).details).toMatchObject({ reason: 'proof_expired', stashes_removed: 0 });
  });
});
