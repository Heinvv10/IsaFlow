// tests/integration/s07c-credential-paths.int.test.ts
//
// Audit 2026-10-18 S-07c: migration 930 takes INSERT and UPDATE on
// company_invitations and company_users, and every privilege on
// auth_password_reset_tokens and admin_impersonation_stash, away from
// app_user; waitlist_signups becomes INSERT-only under RLS. The code now makes
// those writes on the migration_admin pool. This proves every legitimate path
// still works end to end through its real route, on the production logins
// (s07b helpers): invitations created, resent, cancelled, revoked and accepted
// by both accept routes; a password reset; the end of an impersonation; a
// waitlist signup. Only GoTrue (fetch) and outbound email are stubbed, the
// email stub keeping what the mailbox would receive.
// PATs and OAuth: s07c-credential-paths.oauth.int.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import invitationsRoute from '../../pages/api/accounting/company-invitations';
import inviteApiRoute from '../../pages/api/invitations/index';
import revokeRoute from '../../pages/api/invitations/revoke/[id]';
import acceptRoute from '../../pages/api/invitations/[token]/accept';
import inviteRoute from '../../pages/api/invite/[token]';
import forgotRoute from '../../pages/api/auth/forgot-password';
import resetRoute from '../../pages/api/auth/do-reset-password';
import endImpersonationRoute from '../../pages/api/auth/end-impersonation';
import waitlistRoute from '../../pages/api/waitlist';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { hashInviteToken } from '@/lib/auth/inviteToken';
import { stashAdminTokens } from '@/modules/admin/services/userImpersonationService';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';
import { callPublic, clearRateLimits, json, poll, sha256, stubGotrue } from './s07c-credential-paths.helpers';

const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string; text: string }> }));
vi.mock('@/modules/accounting/services/core/emailService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendInviteEmail: vi.fn(async (o: { recipientEmail: string; inviteToken: string }) => {
    mail.sent.push({ to: o.recipientEmail, text: o.inviteToken });
    return { success: true };
  }),
  sendEmail: vi.fn(async (o: { to: string; html: string }) => {
    mail.sent.push({ to: o.to, text: o.html });
    return { success: true };
  }),
}));

const ids = newIds();
const { me, admin, company } = ids;
const created: string[] = [];
const waitlistEmail = `${crypto.randomUUID()}@waitlist.test.local`;

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('ENCRYPTION_KEY', 'disposable-s07c-stash-encryption-key-over-32-characters');
}, 60000);
afterAll(async () => {
  await fixture.query('DELETE FROM auth_password_reset_tokens WHERE user_id = ANY($1::uuid[])', [created]);
  await fixture.query('DELETE FROM waitlist_signups WHERE lower(email) = $1', [waitlistEmail]);
  await fixture.query('DELETE FROM company_users WHERE user_id = ANY($1)', [created]);
  await fixture.query('DELETE FROM users WHERE id = ANY($1)', [created]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool()]);
});
beforeEach(() => clearRateLimits());
afterEach(() => { vi.unstubAllGlobals(); });

/** A fresh id; with a users row (an established account, address `${id}@test.local`) unless `bare`. */
async function newUser(bare = false): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID();
  created.push(id);
  const email = `${id}@test.local`;
  if (!bare) {
    await fixture.query(`INSERT INTO users (id, email, first_name, last_name, is_active, status)
      VALUES ($1, $2, 'S07c', 'S07c', true, 'active')`, [id, email]);
  }
  return { id, email };
}

/** The last thing mailed to `to`, or the 64-hex token inside it. */
const lastMail = (to: string) => mail.sent.filter((m) => m.to === to).at(-1)?.text;
const mailedToken = (to: string) => /([0-9a-f]{64})/.exec(lastMail(to) ?? '')?.[1] ?? null;

const invitation = async (email: string) => (await fixture.query(
  'SELECT * FROM company_invitations WHERE company_id = $1 AND email = $2', [company, email])).rows[0] as Record<string, unknown> | undefined;
const membership = async (userId: string) => (await fixture.query(
  'SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [company, userId])).rows;

const invite = (sub: string, email: string, role: string) =>
  callRoute(invitationsRoute, { sub, method: 'POST', companyId: company, body: { email, role } });

describe('S-07c: /api/accounting/company-invitations and /invite/<token>', () => {
  it('creates (migration_admin INSERT), mails the token, and stamps email_sent_at', async () => {
    const u = await newUser();
    expect(await invite(me, u.email, 'viewer')).toMatchObject({ status: 200, body: { data: { emailSent: true } } });
    const token = mailedToken(u.email)!;
    expect(await invitation(u.email)).toMatchObject({ role: 'viewer', accepted_at: null, token: hashInviteToken(token) });
    expect((await invitation(u.email))!.email_sent_at).toBeInstanceOf(Date);
  });

  it('a resend refreshes the token: the old link is refused, the new one makes the invitee a member', async () => {
    const u = await newUser();
    expect((await invite(me, u.email, 'viewer')).status).toBe(200);
    const old = mailedToken(u.email)!;
    expect((await invite(me, u.email, 'manager')).status).toBe(200);
    const fresh = mailedToken(u.email)!;
    expect(fresh).not.toBe(old);
    expect((await callRoute(inviteRoute, { sub: u.id, method: 'POST', query: { token: old } })).status).toBe(404);
    expect(await membership(u.id)).toEqual([]);
    expect((await callRoute(inviteRoute, { sub: u.id, method: 'POST', query: { token: fresh } })).status).toBe(200);
    expect(await membership(u.id)).toEqual([{ role: 'manager' }]);
    expect((await invitation(u.email))!.accepted_at).toBeInstanceOf(Date);
  });

  it('DELETE cancels a pending invitation', async () => {
    const u = await newUser();
    expect((await invite(me, u.email, 'viewer')).status).toBe(200);
    const { id } = (await invitation(u.email))! as { id: string };
    const r = await callRoute(invitationsRoute, { sub: me, method: 'DELETE', companyId: company, body: { invitationId: id } });
    expect(r).toMatchObject({ status: 200, body: { data: { cancelled: true } } });
    expect(await invitation(u.email)).toBeUndefined();
  });

  it('an admin inviting as owner, and a viewer inviting at all, are refused 403 and write nothing', async () => {
    const [target, viewer] = [await newUser(), await newUser()];
    expect((await invite(me, target.email, 'owner')).status).toBe(403);
    await fixture.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [company, viewer.id]);
    expect((await invite(viewer.id, target.email, 'viewer')).status).toBe(403);
    const api = await callRoute(inviteApiRoute, { sub: viewer.id, method: 'POST', companyId: company, body: { email: target.email, role: 'viewer' } });
    expect(api.status).toBe(403);
    expect(await invitation(target.email)).toBeUndefined();
  });
});

describe('S-07c: /api/invitations, revoke and the password accept route (GoTrue stubbed)', () => {
  /** GoTrue: POST /admin/users creates `gid`; PUT /admin/users/gid and the password grant sign it in; DELETE removes it. */
  function gotrueFor(gid: string, email: string) {
    return stubGotrue(({ method, path }) => {
      if (method === 'POST' && path === '/admin/users') return json(200, { id: gid, email });
      if (method === 'PUT' && path === `/admin/users/${gid}`) return json(200, { id: gid, email });
      if (method === 'DELETE' && path === `/admin/users/${gid}`) return json(200, {});
      if (method === 'POST' && path === '/token?grant_type=password') {
        return json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: gid, email } });
      }
      return undefined;
    });
  }
  const create = (email: string, role: string) =>
    callRoute(inviteApiRoute, { sub: me, method: 'POST', companyId: company, body: { email, role } });
  const accept = (token: string) => callPublic(acceptRoute, { query: { token },
    body: { password: 'a-new-password-0123', firstName: 'Newly', lastName: 'Invited' } });

  it('creates with the GoTrue user id, a resend kills the old link, and the new one is accepted by password', async () => {
    const u = await newUser(true);
    const calls = gotrueFor(u.id, u.email);
    expect(await create(u.email, 'manager')).toMatchObject({ status: 201, body: { data: { emailSent: true } } });
    const old = mailedToken(u.email)!;
    expect(await invitation(u.email)).toMatchObject({ gotrue_user_id: u.id, token: hashInviteToken(old), accepted_at: null });
    expect((await create(u.email, 'manager')).status).toBe(201);
    const fresh = mailedToken(u.email)!;
    expect((await invitation(u.email))!.token).toBe(hashInviteToken(fresh));
    expect((await accept(old)).status).toBe(410);
    const r = await accept(fresh);
    expect(r).toMatchObject({ status: 200, body: { data: { userId: u.id } } });
    expect(await membership(u.id)).toEqual([{ role: 'manager' }]);
    expect((await invitation(u.email))!.accepted_at).toBeInstanceOf(Date);
    expect((await fixture.query('SELECT first_name FROM users WHERE id = $1', [u.id])).rows).toEqual([{ first_name: 'Newly' }]);
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ password: 'a-new-password-0123' });
  });

  it('POST /api/invitations/revoke/[id] deletes a pending invitation and its unused GoTrue user', async () => {
    const u = await newUser(true);
    const calls = gotrueFor(u.id, u.email);
    expect((await create(u.email, 'viewer')).status).toBe(201);
    const { id } = (await invitation(u.email))! as { id: string };
    expect((await callRoute(revokeRoute, { sub: me, method: 'POST', companyId: company, query: { id } })).status).toBe(200);
    expect(await invitation(u.email)).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/admin/users/${u.id}` });
  });

  // Architecture review H1: GoTrue is called holding no migration_admin
  // connection or lock, and a new invitation it could not back is taken back.
  it('GoTrue failing: no migration_admin transaction is open during the call, and the new invitation is withdrawn', async () => {
    const u = await newUser(true);
    let openTx = -1;
    stubGotrue(async ({ method, path }) => {
      if (method !== 'POST' || path !== '/admin/users') return undefined;
      openTx = (await fixture.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE usename = 'migration_admin' AND state LIKE 'idle in transaction%'`)).rows[0].n;
      return json(500, { msg: 'down' });
    });
    expect((await create(u.email, 'viewer')).status).toBe(500);
    expect(openTx).toBe(0);
    expect(await invitation(u.email)).toBeUndefined();
  });
});

describe('S-07c: password reset, end of impersonation, waitlist', () => {
  it('forgot-password mints a token (migration_admin), and do-reset-password consumes it and sets the password', async () => {
    const u = await newUser();
    const calls = stubGotrue(({ method, path }) => {
      if (method === 'GET' && path.startsWith('/admin/users?filter=')) return json(200, { users: [{ id: u.id, email: u.email }] });
      if (method === 'PUT' && path === `/admin/users/${u.id}`) return json(200, { id: u.id, email: u.email });
      if (method === 'POST' && path === '/token?grant_type=password') return json(200, { access_token: 'tmp', user: { id: u.id } });
      if (method === 'POST' && path === '/logout?scope=global') return json(204, null);
      return undefined;
    });
    expect((await callPublic(forgotRoute, { body: { email: u.email } })).status).toBe(200);
    const token = await poll(async () => mailedToken(u.email));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const tokenRow = () => fixture.query('SELECT user_id, consumed_at FROM auth_password_reset_tokens WHERE token_hash = $1', [sha256(token!)]);
    expect((await tokenRow()).rows).toEqual([{ user_id: u.id, consumed_at: null }]);
    const r = await callPublic(resetRoute, { body: { recoveryToken: token, newPassword: 'reset-password-0123' } });
    expect(r.status).toBe(200);
    expect((await tokenRow()).rows[0].consumed_at).toBeInstanceOf(Date);
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ path: `/admin/users/${u.id}`, body: { password: 'reset-password-0123' } });
    expect((await callPublic(resetRoute, { body: { recoveryToken: token, newPassword: 'reset-password-0123' } })).status).toBe(400);
  });

  it('end-impersonation restores the stashed admin session and deletes the stash (migration_admin)', async () => {
    const stashId = await stashAdminTokens({ adminUserId: admin, adminAccessToken: 'admin-access-s07c',
      adminRefreshToken: 'admin-refresh-s07c', targetUserId: me });
    const stashed = () => fixture.query('SELECT target_user_id FROM admin_impersonation_stash WHERE stash_id = $1', [stashId]);
    expect((await stashed()).rows).toEqual([{ target_user_id: me }]);
    const req = request({ 'sb-access-token': await signSession(me, crypto.randomUUID(), 'aal1'), 'sb-admin-stash': stashId }, 'POST');
    const result = response();
    await (endImpersonationRoute as (a: never, b: never) => Promise<unknown>)(req as never, result.res as never);
    expect(result.state.statusCode).toBe(200);
    expect(String(result.headers.get('set-cookie'))).toContain('sb-access-token=admin-access-s07c');
    expect((await stashed()).rows).toEqual([]);
  });

  it('waitlist: a signup is stored and notified once; a repeat is a no-op; the service pool cannot read the table', async () => {
    const body = { email: waitlistEmail, name: 'S07c', signupType: 'direct' };
    expect((await callPublic(waitlistRoute, { body })).status).toBe(200);
    expect((await callPublic(waitlistRoute, { body: { ...body, email: waitlistEmail.toUpperCase() } })).status).toBe(200);
    const rows = await fixture.query('SELECT name FROM waitlist_signups WHERE lower(email) = $1', [waitlistEmail]);
    expect(rows.rows).toEqual([{ name: 'S07c' }]);
    expect(mail.sent.filter((m) => m.text.includes(waitlistEmail))).toHaveLength(1);
    await expect(getDbPool().query('SELECT email FROM waitlist_signups LIMIT 1')).rejects.toMatchObject({ code: '42501' });
  });
});
