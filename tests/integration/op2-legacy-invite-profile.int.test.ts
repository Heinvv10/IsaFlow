// tests/integration/op2-legacy-invite-profile.int.test.ts
//
// OP-2: POST /api/invite/<token> (the signed-in accept, pages/invite/[token].tsx)
// writes the invitee's users row in its transaction, as
// /api/invitations/<token>/accept does (one shared helper, inviteeProfile.ts).
//
// Before, it wrote only the membership. A signed-in GoTrue user with no users
// row got a 200 and a membership withAuth then refused (MISSING_PROFILE); with
// company_users_user_id_fkey (996/997) the COMMIT failed and the route
// answered 500. Pinned here, on the production migration_admin login:
//   · a no-profile invitee gets 200, a users row (the invitation's address,
//     active, onboarding done), the membership at the invited role, and
//     withAuth then admits them to the company;
//   · an existing profile keeps its names and email;
//   · another users row holding the address under another id is a 409 that
//     writes nothing, with the other accept route's EMAIL_IN_USE message;
//   · a session whose email is not the invitation's is still a 403 that
//     writes nothing, no users row included.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
// No GoTrue in the fixture: POST /api/invite/<token> reads the session user's login email through adminGetUser
// (#1468); answer the address this suite's sessions carry (signSession).
// createInvitation looks the address up in GoTrue first (R7-1 pin); this suite has no GoTrue: no account holds it.
vi.mock('@/lib/auth/gotrue', async (orig) => ({ ...(await orig<Record<string, unknown>>()), findUserByEmail: vi.fn(async () => null) }));
vi.mock('@/lib/auth/gotrueAdminUser', async () =>
  (await import('./helpers/fixtureGotrueLogin')).fixtureGotrueLogin((id) => `${id}@test.local`));
import type { NextApiRequest, NextApiResponse } from 'next';
import invitationsRoute from '../../pages/api/accounting/company-invitations';
import inviteRoute from '../../pages/api/invite/[token]';
import { withAuth } from '@/lib/auth';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
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
beforeEach(() => fixture.query(`DELETE FROM rate_limit_counters WHERE key LIKE '%company-invitations%'`));

/** A GoTrue identity: the session's email claim is `${id}@test.local` (signSession). No users row unless `profile`. */
async function newIdentity(profile?: { firstName: string }): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID();
  created.push(id);
  const email = `${id}@test.local`;
  if (profile) {
    await fixture.query(`INSERT INTO users (id, email, first_name, last_name, is_active, status, onboarding_completed)
      VALUES ($1, $2, $3, 'Kept', true, 'active', false)`, [id, email, profile.firstName]);
  }
  return { id, email };
}

async function invitedToken(email: string, role = 'manager'): Promise<string> {
  const r = await callRoute(invitationsRoute, { sub: me, method: 'POST', companyId: company, body: { email, role } });
  expect(r.status).toBe(200);
  const m = mail.sent.filter((s) => s.recipientEmail === email).at(-1);
  if (!m) throw new Error(`no invite mailed to ${email}`);
  return m.inviteToken;
}

const accept = (sub: string, token: string) => callRoute(inviteRoute, { sub, method: 'POST', query: { token } });
const memberships = async (userId: string) =>
  (await fixture.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [company, userId])).rows;
const profile = async (userId: string) => (await fixture.query(
  'SELECT email, first_name, last_name, is_active, status, onboarding_completed FROM users WHERE id = $1', [userId])).rows;
const acceptedAt = async (email: string) => (await fixture.query(
  'SELECT accepted_at FROM company_invitations WHERE company_id = $1 AND email = $2', [company, email])).rows[0]?.accepted_at;

/** withAuth's own verdict for `sub` in the company: a handler that answers 200 if admitted. */
const admitted = withAuth(async (_req: NextApiRequest, res: NextApiResponse) => { res.status(200).json({ ok: true }); });

describe('OP-2: POST /api/invite/<token> writes the invitee\'s users row', () => {
  it('a signed-in invitee with no users row: 200, a profile, the membership, and withAuth admits them', async () => {
    const u = await newIdentity();
    const r = await accept(u.id, await invitedToken(u.email, 'manager'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await profile(u.id)).toEqual([{
      email: u.email, first_name: null, last_name: null, is_active: true, status: 'active', onboarding_completed: true,
    }]);
    expect(await memberships(u.id)).toEqual([{ role: 'manager' }]);
    expect(await acceptedAt(u.email)).not.toBeNull();
    const gate = await callRoute(admitted, { sub: u.id, method: 'GET', companyId: company });
    expect(gate.status, JSON.stringify(gate.body)).toBe(200);
  });

  it('an existing profile keeps its names and email; onboarding is marked done as before', async () => {
    const u = await newIdentity({ firstName: 'Mine' });
    const r = await accept(u.id, await invitedToken(u.email, 'viewer'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await profile(u.id)).toEqual([{
      email: u.email, first_name: 'Mine', last_name: 'Kept', is_active: true, status: 'active', onboarding_completed: true,
    }]);
    expect(await memberships(u.id)).toEqual([{ role: 'viewer' }]);
  });

  it('another users row holding the address under another id: 409 with the EMAIL_IN_USE message, nothing written', async () => {
    const u = await newIdentity();
    const legacy = crypto.randomUUID();
    created.push(legacy);
    const token = await invitedToken(u.email);
    await fixture.query(`INSERT INTO users (id, email, is_active) VALUES ($1, $2, true)`, [legacy, u.email]);
    const r = await accept(u.id, token);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect((r.body as { error?: { message?: string } }).error?.message).toMatch(/already attached to a different IsaFlow profile/);
    expect(await profile(u.id)).toEqual([]);
    expect(await memberships(u.id)).toEqual([]);
    expect(await acceptedAt(u.email)).toBeNull();
  });

  // brk-1440 M: users_email_key is case-sensitive; the helper refuses a case variant itself.
  it('another users row holding the address in a different case: the same 409, no second users row', async () => {
    const u = await newIdentity();
    const legacy = crypto.randomUUID();
    created.push(legacy);
    const token = await invitedToken(u.email);
    await fixture.query(`INSERT INTO users (id, email, is_active) VALUES ($1, $2, true)`, [legacy, u.email.toUpperCase()]);
    const r = await accept(u.id, token);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect((r.body as { error?: { message?: string } }).error?.message).toMatch(/already attached to a different IsaFlow profile/);
    expect((await fixture.query('SELECT id FROM users WHERE lower(email) = lower($1)', [u.email])).rows).toEqual([{ id: legacy }]);
    expect(await memberships(u.id)).toEqual([]);
    expect(await acceptedAt(u.email)).toBeNull();
  });

  // 999: a second row in another case can no longer exist (users_email_lower_key). What remains is a
  // profile stored in mixed case before 999, which is never rewritten: it accepts and keeps its spelling.
  it('an existing profile stored in a different case accepts as before, and its stored email is not rewritten', async () => {
    const u = await newIdentity({ firstName: 'Mine' });
    await fixture.query('UPDATE users SET email = $2 WHERE id = $1', [u.id, u.email.toUpperCase()]);
    const r = await accept(u.id, await invitedToken(u.email, 'viewer'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await profile(u.id))[0]).toMatchObject({ email: u.email.toUpperCase(), first_name: 'Mine' });
    expect(await memberships(u.id)).toEqual([{ role: 'viewer' }]);
  });

  // brk-1440 L1: the membership was written under $2::UUID (canonical) and the users row under the raw sub.
  it('an upper-case session id: the users row and the membership are both written under the canonical lower-case id', async () => {
    const u = await newIdentity();
    const upper = u.id.toUpperCase();
    created.push(upper);
    const r = await accept(upper, await invitedToken(u.email, 'viewer'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await fixture.query('SELECT id FROM users WHERE lower(id) = $1', [u.id])).rows).toEqual([{ id: u.id }]);
    expect((await fixture.query('SELECT user_id FROM company_users WHERE company_id = $1 AND lower(user_id) = $2', [company, u.id])).rows)
      .toEqual([{ user_id: u.id }]);
  });

  it('a session whose email is not the invitation\'s: 403, and no profile or membership is written', async () => {
    const [u, other] = [await newIdentity(), await newIdentity()];
    const r = await accept(other.id, await invitedToken(u.email));
    expect(r.status).toBe(403);
    expect(await profile(other.id)).toEqual([]);
    expect(await memberships(other.id)).toEqual([]);
    expect(await acceptedAt(u.email)).toBeNull();
  });
});
