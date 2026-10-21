// tests/integration/s07-users-privilege-columns.int.test.ts
//
// Audit 2026-10-18 S-07: app_user must not be able to change a user's
// privilege or standing columns, even on its own row.
//
// `users_self_write` (mig 348) lets a request UPDATE the caller's own users
// row, and mig 348 granted app_user table-level INSERT/UPDATE on every table.
// withPlatformAdmin trusts users.role, so `UPDATE users SET role =
// 'super_admin' WHERE id = auth.uid()` from any SQL injection on an app_user
// route was a platform takeover. Migration 902 narrows app_user's UPDATE to
// the columns its writers name and takes INSERT away. email stays granted
// for the POPIA erasure but is trigger-pinned to the row's own placeholder,
// because createInvitation adds an existing user to a company by email.
//
// Outcome-based: every forbidden write is attempted as app_user and must be
// refused with 42501 "permission denied for table users". That exact text,
// because RLS refusals share the SQLSTATE ("new row violates row-level
// security policy"), and SET LOCAL ROLE failing would too.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import profileRoute from '../../pages/api/auth/profile';
import dsrRoute from '../../pages/api/accounting/data-subject-rights';
import onboardingCompleteRoute from '../../pages/api/onboarding/complete';
import changeEmailRoute from '../../pages/api/auth/change-email';
import inviteRoute from '../../pages/api/invite/[token]';
import acceptRoute from '../../pages/api/invitations/[token]/accept';
import { provisionTenant } from '@/modules/onboarding/services/tenantProvisioningService';
import { markOnboardingCompleted } from '@/modules/onboarding/services/onboardingSetupWriters';
import { suspendUser, activateUser, resetOnboarding } from '@/modules/admin/services/adminUserActionsService';
import { updateUser } from '@/modules/admin/services/adminUserService';
import { convertUserToBureauOwner } from '@/modules/bureau/services/bureauService';
import { hashInviteToken } from '@/lib/auth/inviteToken';
import { pool, asRole, inServiceContext, callRoute, userRow, urlAsRole } from './s07-users-privilege-columns.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

/** Every column app_user may UPDATE; each is named by a writer that runs as app_user. email is trigger-pinned. */
const GRANTED = ['first_name', 'last_name', 'phone', 'mobile', 'email', 'updated_at', 'onboarding_completed'];
/** The columns S-07 is about, plus the rest of the standing/privilege set. */
const FORBIDDEN = ['role', 'status', 'is_active', 'suspended_at', 'suspended_reason', 'permissions', 'account_type'];
const DENIED = /permission denied for table users/i;

const me = crypto.randomUUID();
const company = crypto.randomUUID();
const invitee = crypto.randomUUID();
const inviteToken = `s07-${crypto.randomUUID()}`;
/** A brand-new invitee accepted through /api/invitations/[token]/accept (INSERT writer 1). */
const acceptee = crypto.randomUUID();
const acceptToken = `s07a-${crypto.randomUUID()}`;
/** A self-serve signup owner provisioned by tenantProvisioningService (INSERT writer 2). */
const signup = crypto.randomUUID();

beforeAll(async () => {
  // GoTrue is a fetch stub in the tests that reach it; the keys only have to exist.
  vi.stubEnv('SUPABASE_ANON_KEY', 'x');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'x');
  // The accept route builds its pool from this URL: run it as production's migration_admin.
  vi.stubEnv('MIGRATION_ADMIN_DATABASE_URL', urlAsRole('migration_admin'));
  await pool.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, 'S07 fixture', true)`, [company]);
  for (const id of [me, invitee]) {
    await pool.query(`INSERT INTO users (id, email, first_name, last_name, role, is_active, onboarding_completed)
      VALUES ($1, $2, 'Before', 'Before', 'viewer', true, NULL)`, [id, `${id}@test.local`]);
  }
  await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)`, [company, me]);
  await pool.query(`INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at)
    VALUES ($1, $2, 'viewer', $3, $4, NOW() + interval '1 day')`, [company, `${invitee}@test.local`, me, hashInviteToken(inviteToken)]);
  await pool.query(`INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at, gotrue_user_id)
    VALUES ($1, $2, 'viewer', $3, $4, NOW() + interval '1 day', $5)`,
  [company, `${acceptee}@test.local`, me, hashInviteToken(acceptToken), acceptee]);
}, 60000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bureau_users WHERE user_id = ANY($1)', [[me, invitee]]);
    await pool.query('DELETE FROM bureaus WHERE owner_user_id = ANY($1)', [[me, invitee]]);
    await pool.query('DELETE FROM company_invitations WHERE company_id = $1', [company]);
    const owned = await pool.query('SELECT company_id FROM company_users WHERE user_id = $1', [signup]);
    const companies = [company, ...owned.rows.map(r => r.company_id as string)];
    for (const t of ['fiscal_periods', 'subscriptions', 'company_users']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [companies]);
    }
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1)', [[me, invitee, acceptee, signup]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[me, invitee, acceptee, signup]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
    await pool.query(`DELETE FROM rate_limit_counters WHERE key = 'invite-accept:' || $1`, [hashInviteToken(acceptToken)]);
    await pool.query(`DELETE FROM rate_limit_counters WHERE key LIKE '%' || $1 || '%' OR key LIKE '%127.0.0.79%'`, [me]);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await pool.end();
  }
});

describe('S-07: app_user cannot write privilege columns on users', () => {
  it.each(FORBIDDEN)('refuses UPDATE of %s on the caller\'s own row', async (col) => {
    const value = col === 'permissions' ? `'{"all":true}'::jsonb` : col === 'is_active' ? 'NOT is_active'
      : col === 'suspended_at' ? 'NOW()' : col === 'account_type' ? `'bureau_owner'`
      : col === 'role' ? `'super_admin'` : `'forged'`;
    const refused = await asRole('app_user', me, (q) => q(`UPDATE users SET ${col} = ${value} WHERE id = auth.uid()`));
    expect(refused?.code).toBe('42501');
    expect(refused?.message).toMatch(DENIED);
  });

  it('refuses UPDATE ... FROM that sets role', async () => {
    const refused = await asRole('app_user', me, (q) =>
      q(`UPDATE users u SET role = 'super_admin' FROM (SELECT auth.uid() AS uid) s WHERE u.id = s.uid`));
    expect(refused?.message).toMatch(DENIED);
  });

  it('refuses INSERT of a super_admin row, and the ON CONFLICT DO UPDATE form', async () => {
    const insert = await asRole('app_user', me, (q) =>
      q(`INSERT INTO users (id, email, role) VALUES (auth.uid(), 'x@test.local', 'super_admin')`));
    expect(insert?.message).toMatch(DENIED);
    const upsert = await asRole('app_user', me, (q) => q(`INSERT INTO users (id, email) VALUES (auth.uid(), 'x@test.local')
      ON CONFLICT (id) DO UPDATE SET role = 'super_admin'`));
    expect(upsert?.message).toMatch(DENIED);
    expect((await userRow(me)).role).toBe('viewer');
  });

  // email is privilege-bearing (createInvitation adds an existing users row to the
  // company by email); app_user may only set its own row's erasure placeholder.
  it('refuses an app_user email change to anything but the row\'s erasure placeholder', async () => {
    const refused = await asRole('app_user', me, (q) =>
      q(`UPDATE users SET email = 'pending-invitee@victim.test' WHERE id = auth.uid()`));
    expect(refused).toMatchObject({ code: '42501' });
    expect(refused?.message).toMatch(/erasure placeholder/);
    const placeholder = await asRole('app_user', me, (q) =>
      q(`UPDATE users SET email = 'anonymized_' || left(id, 8) || '@deleted.invalid' WHERE id = auth.uid()`));
    expect(placeholder).toBeNull();
  });

  it('a claim forged inside the statement cannot steer the email write onto another user', async () => {
    let updated = -1;
    const refused = await asRole('app_user', me, async (q) => {
      const r = await q(`WITH f AS MATERIALIZED (SELECT set_config('request.jwt.claims', $1, true) AS c)
        UPDATE users SET first_name = 'pwn', email = 'anonymized_' || left(id, 8) || '@deleted.invalid'
          FROM f WHERE users.id = $2 AND f.c IS NOT NULL`, [JSON.stringify({ sub: invitee }), invitee]) as { rowCount: number };
      updated = r.rowCount;
    });
    expect(refused).toBeNull();
    expect(updated).toBe(0);
    expect((await userRow(invitee)).email).toBe(`${invitee}@test.local`);
  });

  it('leaves app_user exactly the granted UPDATE columns and no INSERT, directly or through any role', async () => {
    const cols = await pool.query<{ column_name: string; upd: boolean; ins: boolean }>(
      `SELECT column_name, has_column_privilege('app_user', 'public.users', column_name, 'UPDATE') AS upd,
              has_column_privilege('app_user', 'public.users', column_name, 'INSERT') AS ins
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'`);
    expect(cols.rows.filter(r => r.upd).map(r => r.column_name).sort()).toEqual([...GRANTED].sort());
    expect(cols.rows.filter(r => r.ins)).toEqual([]);
    // A role app_user can SET ROLE to (or inherits) that may write `role`.
    const escalation = await pool.query(`SELECT r.rolname FROM pg_roles r
      WHERE r.rolname <> 'app_user' AND pg_has_role('app_user', r.oid, 'MEMBER')
        AND (has_column_privilege(r.oid, 'public.users', 'role', 'UPDATE')
          OR has_column_privilege(r.oid, 'public.users', 'role', 'INSERT'))`);
    expect(escalation.rows).toEqual([]);
    // PUBLIC (grantee 0) holds no INSERT or UPDATE, at table or column level.
    const pub = await pool.query(`SELECT a.privilege_type FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = 'public.users'::regclass AND a.grantee = 0 AND a.privilege_type IN ('INSERT', 'UPDATE')
      UNION ALL SELECT a.privilege_type FROM pg_attribute t, aclexplode(t.attacl) a
      WHERE t.attrelid = 'public.users'::regclass AND a.grantee = 0 AND a.privilege_type IN ('INSERT', 'UPDATE')`);
    expect(pub.rows).toEqual([]);
    const guard = await pool.query(`SELECT tgenabled FROM pg_trigger
      WHERE tgrelid = 'public.users'::regclass AND tgname = 'users_app_user_email_guard'`);
    expect(guard.rows).toEqual([{ tgenabled: 'O' }]);
  });

  it('re-applies cleanly and leaves the same privileges', async () => {
    const dir = join(process.cwd(), 'scripts/migrations/sql');
    const file = readdirSync(dir).find(f => /^\d{3}[a-z]?_users_privilege_columns_app_user\.sql$/.test(f));
    expect(file).toBeDefined();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(join(dir, file!), 'utf8'));
      await client.query(readFileSync(join(dir, file!), 'utf8'));
      const r = await client.query(`SELECT has_table_privilege('app_user', 'public.users', 'UPDATE') AS t,
        has_column_privilege('app_user', 'public.users', 'role', 'UPDATE') AS role,
        has_column_privilege('app_user', 'public.users', 'first_name', 'UPDATE') AS first_name`);
      expect(r.rows[0]).toEqual({ t: false, role: false, first_name: true });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('S-07: every legitimate users writer still succeeds', () => {
  it('profile PUT (withAuth, app_user) writes names and phones', async () => {
    const r = await callRoute(profileRoute, { sub: me, method: 'PUT', companyId: company,
      body: { firstName: 'Thandi', lastName: 'Mokoena', phone: '0110000000', mobile: '0820000000' } });
    expect(r.status).toBe(200);
    expect(await userRow(me)).toMatchObject({ first_name: 'Thandi', last_name: 'Mokoena', phone: '0110000000', mobile: '0820000000' });
  });

  it('onboarding/complete POST (withAuth, app_user) sets onboarding_completed', async () => {
    const r = await callRoute(onboardingCompleteRoute, { sub: me, method: 'POST', companyId: company });
    expect(r.status).toBe(200);
    expect((await userRow(me)).onboarding_completed).toBe(true);
  });

  it('markOnboardingCompleted (complete-setup, app_user) sets onboarding_completed', async () => {
    await pool.query('UPDATE users SET onboarding_completed = false WHERE id = $1', [me]);
    await inServiceContext('app_user', me, () => markOnboardingCompleted(me));
    expect((await userRow(me)).onboarding_completed).toBe(true);
  });

  it('platform_admin: updateUser changes role; suspend, activate and resetOnboarding write standing', async () => {
    // suspendUser ends the user's GoTrue sessions; a 204 stands in for GoTrue.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await inServiceContext('platform_admin', invitee, () => updateUser(me, { role: 'admin' }));
    expect((await userRow(me)).role).toBe('admin');
    await inServiceContext('platform_admin', invitee, () => suspendUser(me, 's07 test'));
    expect(await userRow(me)).toMatchObject({ is_active: false, suspended_reason: 's07 test' });
    await inServiceContext('platform_admin', invitee, () => activateUser(me));
    expect(await userRow(me)).toMatchObject({ is_active: true, suspended_reason: null, suspended_at: null });
    await inServiceContext('platform_admin', invitee, () => resetOnboarding(invitee));
    expect((await userRow(invitee)).onboarding_completed).toBe(false);
    await inServiceContext('platform_admin', invitee, () => convertUserToBureauOwner({ userId: invitee, bureauName: 'S07 Bureau' }));
    expect((await userRow(invitee)).account_type).toBe('bureau_owner');
    vi.unstubAllGlobals();
  });

  it('invite/[token] POST (withUserAuth, pool role) sets onboarding_completed', async () => {
    const r = await callRoute(inviteRoute, { sub: invitee, method: 'POST', query: { token: inviteToken } });
    expect(r.status).toBe(200);
    expect((await userRow(invitee)).onboarding_completed).toBe(true);
  });

  it('change-email POST (withUserAuth, pool role) mirrors the new email', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'x', id: me }), {
      status: 200, headers: { 'content-type': 'application/json' } })));
    const r = await callRoute(changeEmailRoute, { sub: me, method: 'POST',
      body: { newEmail: `${me}-new@test.local`, currentPassword: 'pw' } });
    vi.unstubAllGlobals();
    expect(r).toMatchObject({ status: 200 });
    expect((await userRow(me)).email).toBe(`${me}-new@test.local`);
  });

  it('the migration-admin pool URL really runs as migration_admin', async () => {
    const { Pool } = await import('pg');
    const p = new Pool({ connectionString: process.env.MIGRATION_ADMIN_DATABASE_URL, max: 1 });
    try {
      expect((await p.query('SELECT current_user AS u')).rows[0].u).toBe('migration_admin');
    } finally {
      await p.end();
    }
  });

  it('invitations/[token]/accept (migration_admin pool) INSERTs the new invitee\'s users row', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const body = String(input).includes('/token')
        ? { access_token: await signSession(acceptee, crypto.randomUUID(), 'aal2'), refresh_token: 'r', expires_in: 3600,
          token_type: 'bearer', user: { id: acceptee } }
        : { id: acceptee };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const r = await callRoute(acceptRoute, { sub: acceptee, method: 'POST', query: { token: acceptToken },
      body: { password: 's07-long-enough-password', firstName: 'Sipho', lastName: 'Dlamini' } });
    vi.unstubAllGlobals();
    expect(r).toMatchObject({ status: 200 });
    expect(await userRow(acceptee)).toMatchObject({ first_name: 'Sipho', is_active: true });
  });

  it('tenantProvisioningService (verify-email, migration_admin) INSERTs the owner as admin', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE migration_admin');
      await provisionTenant(client, { ownerUserId: signup, email: `${signup}@test.local`, firstName: 'Lerato',
        lastName: 'Nkosi', companyName: `S07 signup ${signup}`, phone: null, annualTurnoverCents: null, signupType: 'direct' });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    expect(await userRow(signup)).toMatchObject({ role: 'admin', is_active: true, first_name: 'Lerato' });
  });

  it('data-subject-rights erasure (withAuth, app_user) anonymises names and email', async () => {
    const r = await callRoute(dsrRoute, { sub: me, method: 'POST', companyId: company, body: { action: 'erasure' } });
    expect(r.status).toBe(200);
    expect(await userRow(me)).toMatchObject({ first_name: 'Anonymized', email: `anonymized_${me.slice(0, 8)}@deleted.invalid` });
  });
});
