/**
 * OP-2 breaker (brk-1440, M): users_email_key is case-sensitive, so a brand-new invitee whose
 * address another users row already holds in a different case got a SECOND users row from
 * POST /api/invitations/<token>/accept instead of the EMAIL_IN_USE 409. inviteeProfile.ts now
 * refuses it case-insensitively before it creates the row. The legacy route
 * (POST /api/invite/<token>) shares the helper; its case is in op2-legacy-invite-profile.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { response } from './mfa-impersonation-postgres.helpers';
import {
  acceptRequest, extraAccounts, getAccept, inviter, pool, setupInviteFixture, shortPwCompany, stored,
  teardownInviteFixture,
} from './k-041-invite-accept.helpers';

const invitee = crypto.randomUUID();
const legacy = crypto.randomUUID();
const email = `op2-case-${invitee}@test.local`;
const inviteToken = `op2c${'0'.repeat(28)}${invitee.replace(/-/g, '')}`;
const typed = `op2-case-${invitee}`;

beforeAll(setupInviteFixture);
afterAll(async () => {
  // Before the fixture's teardown, which ends the pool.
  await pool.query('DELETE FROM company_users WHERE user_id = ANY($1::text[])', [[invitee, legacy]]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[invitee, legacy]]);
  await teardownInviteFixture();
});

it('an address another users row holds in a different case: 409 EMAIL_IN_USE, no second users row, no membership', async () => {
  await pool.query('INSERT INTO users(id,email,is_active) VALUES($1,$2,true)', [legacy, email.toUpperCase()]);
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now()+interval '7 days', $5)`,
    [shortPwCompany, email, inviter, stored(inviteToken), invitee]);
  extraAccounts.set(email, { id: invitee, password: typed });
  const result = response();

  await getAccept()(acceptRequest(inviteToken, typed, '127.0.0.95'), result.res);

  expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(409);
  expect(result.state.body).toMatchObject({ error: { code: 'EMAIL_IN_USE' } });
  expect((await pool.query('SELECT id FROM users WHERE lower(email) = lower($1) ORDER BY id', [email])).rows)
    .toEqual([{ id: legacy }]);
  expect((await pool.query('SELECT 1 FROM company_users WHERE user_id = $1', [invitee])).rowCount).toBe(0);
  expect((await pool.query('SELECT accepted_at FROM company_invitations WHERE token = $1', [stored(inviteToken)])).rows)
    .toEqual([{ accepted_at: null }]);
});
