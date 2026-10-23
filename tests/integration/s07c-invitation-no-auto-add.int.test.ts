// tests/integration/s07c-invitation-no-auto-add.int.test.ts
//
// S-07c A (Hein, 2026-10-23, decision 1): createInvitation never adds an
// existing `users` row to the company. Every invitee, account or not, gets a
// token by email and accepts it at /invite/<token>, which checks that the
// signed-in session's email is the invitation's.
//
// Before, an address with a users row was added at once. change-email sets an
// address without proving it is owned (email_confirm: true, decision 1 keeps
// it), so anyone could take an address a company was about to invite and be
// added in its owner's place.
//
// Real routes on the production logins; GoTrue and the invite email are
// stubbed, the email stub keeping the raw token the mailbox would receive.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import invitationsRoute from '../../pages/api/accounting/company-invitations';
import inviteRoute from '../../pages/api/invite/[token]';
import changeEmailRoute from '../../pages/api/auth/change-email';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { createInvitation, InvitationForbiddenError } from '@/modules/accounting/services/core/userInvitationService';
import { OwnerProtectedError } from '@/modules/accounting/services/core/ownerLock';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const mail = vi.hoisted(() => ({ sent: [] as Array<{ recipientEmail: string; inviteToken: string }> }));
vi.mock('@/modules/accounting/services/core/emailService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendInviteEmail: vi.fn(async (o: { recipientEmail: string; inviteToken: string }) => {
    mail.sent.push({ recipientEmail: o.recipientEmail, inviteToken: o.inviteToken });
    return { success: true };
  }),
}));

const ids = newIds();
const { me, company } = ids;
const created: string[] = [];

beforeAll(() => setup(ids), 60000);
afterAll(async () => {
  await fixture.query('DELETE FROM company_users WHERE user_id = ANY($1)', [created]);
  await fixture.query('DELETE FROM users WHERE id = ANY($1)', [created]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool()]);
});
beforeEach(() => fixture.query(`DELETE FROM rate_limit_counters WHERE key LIKE '%company-invitations%' OR key LIKE '%change-email%'`));

/** A user with a profile row (an established account) and no membership. */
async function newUser(): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID();
  created.push(id);
  const email = `${id}@test.local`;
  await fixture.query(`INSERT INTO users (id, email, first_name, last_name, is_active, status)
    VALUES ($1, $2, 'S07c', 'S07c', true, 'active')`, [id, email]);
  return { id, email };
}

const memberships = async (userId: string) =>
  (await fixture.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [company, userId])).rows;

const invite = (email: string, role = 'manager') =>
  callRoute(invitationsRoute, { sub: me, method: 'POST', companyId: company, body: { email, role } });

const tokenFor = (email: string): string => {
  const m = mail.sent.filter((s) => s.recipientEmail === email).at(-1);
  if (!m) throw new Error(`no invite mailed to ${email}`);
  return m.inviteToken;
};

/** Accept as `sub`, signed in; its session's email claim is `${sub}@test.local`, its users row's address. */
const accept = (sub: string, token: string) =>
  callRoute(inviteRoute, { sub, method: 'POST', query: { token } });

describe('S-07c A: an existing account is invited, never added', () => {
  it('the route answers autoAdded: false, mails a token, and writes a pending invitation and no membership', async () => {
    const u = await newUser();
    const r = await invite(u.email);
    expect(r).toMatchObject({ status: 200, body: { data: { autoAdded: false, emailSent: true } } });
    expect(await memberships(u.id)).toEqual([]);
    const inv = await fixture.query('SELECT role, accepted_at FROM company_invitations WHERE company_id = $1 AND email = $2',
      [company, u.email]);
    expect(inv.rows).toEqual([{ role: 'manager', accepted_at: null }]);
    expect(tokenFor(u.email)).toMatch(/^[0-9a-f]{64}$/);
    // Written on the migration_admin pool, still recorded as the inviter's, in their session.
    const log = await fixture.query(`SELECT e.actor, e.channel FROM entity_changes e JOIN company_invitations i ON i.id = e.entity_id
      WHERE i.company_id = $1 AND i.email = $2 AND e.op = 'create'`, [company, u.email]);
    expect(log.rows).toEqual([{ actor: me, channel: 'session' }]);
  });

  // The route runs as app_user, which reads only its own users row, so the
  // auto-add above never matched through it. createInvitation outside a
  // request runs on the service pool, which reads every users row: that is
  // where the deleted branch still added the account.
  it('createInvitation off a request (service pool) adds no membership either', async () => {
    const u = await newUser();
    const result = await createInvitation(company, u.email, 'viewer', me);
    expect(result.autoAdded).toBe(false);
    expect(result.invitation?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await memberships(u.id)).toEqual([]);
  });

  it('the invitee, signed in, accepts at /invite/<token> and becomes a member at the invited role', async () => {
    const u = await newUser();
    expect((await invite(u.email, 'manager')).status).toBe(200);
    const r = await accept(u.id, tokenFor(u.email));
    expect(r.status).toBe(200);
    expect(await memberships(u.id)).toEqual([{ role: 'manager' }]);
  });

  it('a different signed-in user holding the token is refused 403 and added nowhere', async () => {
    const [u, other] = [await newUser(), await newUser()];
    expect((await invite(u.email)).status).toBe(200);
    const r = await accept(other.id, tokenFor(u.email));
    expect(r.status).toBe(403);
    expect(await memberships(other.id)).toEqual([]);
    expect(await memberships(u.id)).toEqual([]);
  });

  it('an address that is already a member is refused, and nothing is written', async () => {
    const u = await newUser();
    await fixture.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [company, u.id]);
    const before = mail.sent.length;
    const r = await invite(u.email.toUpperCase());
    expect(r).toMatchObject({ status: 409, body: { error: { message: 'This user is already a member of the company.' } } });
    expect(mail.sent.length).toBe(before);
    expect((await fixture.query('SELECT 1 FROM company_invitations WHERE company_id = $1 AND lower(email) = $2',
      [company, u.email])).rows).toEqual([]);
  });

  it('the hijack: U takes address X by change-email, C invites X, and U is not a member of C', async () => {
    const u = await newUser();
    const x = `${crypto.randomUUID()}@victim.test.local`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'x', id: u.id }), {
      status: 200, headers: { 'content-type': 'application/json' } })));
    try {
      const ce = await callRoute(changeEmailRoute, { sub: u.id, method: 'POST', body: { newEmail: x, currentPassword: 'pw' } });
      expect(ce.status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
    expect((await fixture.query('SELECT email FROM users WHERE id = $1', [u.id])).rows).toEqual([{ email: x }]);
    // Through the route and through the service pool: neither adds U.
    expect(await invite(x)).toMatchObject({ status: 200, body: { data: { autoAdded: false } } });
    expect((await createInvitation(company, x, 'admin', me)).autoAdded).toBe(false);
    expect(await memberships(u.id)).toEqual([]);
  });
});

// The guard trigger does not judge migration_admin, so createInvitation checks
// its rules itself, against the inviter's membership as it stands: the routes'
// own checks read the role once, when the request began.
describe('S-07c A: createInvitation checks the inviter (assertCanInvite)', () => {
  const pending = async (email: string) =>
    (await fixture.query('SELECT 1 FROM company_invitations WHERE company_id = $1 AND email = $2', [company, email])).rows.length;

  it('an admin may not invite an owner', async () => {
    const email = `${crypto.randomUUID()}@test.local`;
    await expect(createInvitation(company, email, 'owner', me)).rejects.toBeInstanceOf(OwnerProtectedError);
    expect(await pending(email)).toBe(0);
  });

  it('an owner may', async () => {
    const email = `${crypto.randomUUID()}@test.local`;
    expect((await createInvitation(company, email, 'owner', ids.owner)).invitation.role).toBe('owner');
  });

  it.each([
    ['a viewer', 'viewer'],
    ['an admin demoted since the request began', 'manager'],
  ])('%s may not invite at all', async (_, role) => {
    const u = await newUser();
    await fixture.query('INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)', [company, u.id, role]);
    const email = `${crypto.randomUUID()}@test.local`;
    await expect(createInvitation(company, email, 'viewer', u.id)).rejects.toBeInstanceOf(InvitationForbiddenError);
    expect(await pending(email)).toBe(0);
  });

  // 883's RC003 judged these for app_user; the rules now sit in assertCanInvite.
  it('an admin may re-issue a pending owner invitation only as a lesser one; it never stays owner under them', async () => {
    const email = `${crypto.randomUUID()}@test.local`;
    await createInvitation(company, email, 'owner', ids.owner);
    const before = (await fixture.query('SELECT token FROM company_invitations WHERE company_id = $1 AND email = $2', [company, email])).rows[0];
    await expect(createInvitation(company, email, 'owner', me)).rejects.toBeInstanceOf(OwnerProtectedError);
    expect((await fixture.query('SELECT role, token, invited_by FROM company_invitations WHERE company_id = $1 AND email = $2',
      [company, email])).rows).toEqual([{ role: 'owner', token: before.token, invited_by: ids.owner }]);
    // A re-invite at another role, as 883 allowed: it becomes the admin's viewer invitation.
    await createInvitation(company, email, 'viewer', me);
    expect((await fixture.query('SELECT role, invited_by FROM company_invitations WHERE company_id = $1 AND email = $2',
      [company, email])).rows).toEqual([{ role: 'viewer', invited_by: me }]);
  });

  it('nor may someone who is not a member', async () => {
    const u = await newUser();
    const email = `${crypto.randomUUID()}@test.local`;
    await expect(createInvitation(ids.other, email, 'viewer', u.id)).rejects.toBeInstanceOf(InvitationForbiddenError);
  });
});
