/**
 * K-041: accepting a company invitation reset the password of an account that
 * ALREADY exists, with no proof the acceptor owns that account.
 *
 * pages/api/invitations/[token]/accept.ts called adminUpdateUser({ password })
 * unconditionally on the invitation's gotrue_user_id. When the invited address
 * already has an IsaFlow login (pages/api/invitations/index.ts resolves the
 * EXISTING GoTrue user on 422), that login's credentials were replaced by
 * whatever the invite link holder typed.
 *
 * The fix branches on whether a `users` row already exists for that GoTrue id:
 *  - it does  -> never touch the password; the typed password must sign in.
 *  - it does not -> unchanged registration path, the typed password is set.
 *
 * The original RED assertion (no password patch) is kept verbatim. Its
 * companion `statusCode === 200` described master's behaviour, not the fixed
 * contract: an acceptor who cannot prove ownership is now refused, so that
 * expectation is 401 here and 200 is asserted in the ownership-proof case.
 *
 * The fixture and GoTrue stub live in ./k-041-invite-accept.helpers, shared
 * with k-041-invite-accept-adjacent.int.test.ts. The later rounds' adjacent
 * cases moved there when this file passed the 300-line ceiling in CLAUDE.md.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { response } from './mfa-impersonation-postgres.helpers';
import {
  REAL_PASSWORD, SHORT_PASSWORD, acceptRequest, cappedCompany, cappedToken, email,
  existingCompany, existingUser, getAccept, invitingCompany, inviteId, inviter, issued,
  newEmail, newInvitee, newInviteeCompany, newToken, outageToken, outageUser, passwordPatches,
  pool, setRecording, setupInviteFixture, shortPwCompany, shortPwToken, shortPwUser, stored,
  teardownInviteFixture, token,
} from './k-041-invite-accept.helpers';

beforeAll(setupInviteFixture);
afterAll(teardownInviteFixture);

it('does NOT reset an already-registered account password when its invitation is accepted', async () => {
  const result = response();

  await getAccept()(acceptRequest(token, 'attacker-chosen-password-2026', '127.0.0.82'), result.res);

  // The original RED assertion: no password was pushed onto the existing account.
  expect(passwordPatches).toEqual([]);
  expect(result.state.statusCode).toBe(401);
  expect(result.state.body).toMatchObject({ error: { code: 'SIGN_IN_REQUIRED' } });
  // No membership was granted on an unproven acceptance, and the invitation is
  // still open for the real owner.
  const granted = await pool.query('SELECT 1 FROM company_users WHERE company_id=$1 AND user_id=$2',
    [invitingCompany, existingUser]);
  expect(granted.rowCount).toBe(0);
  const inv = await pool.query('SELECT accepted_at FROM company_invitations WHERE id=$1', [inviteId]);
  expect(inv.rows[0].accepted_at).toBeNull();
});

it('attaches the membership when the existing account proves ownership with its own password', async () => {
  const result = response();

  await getAccept()(acceptRequest(token, REAL_PASSWORD, '127.0.0.82'), result.res);

  expect(result.state.statusCode).toBe(200);
  expect(passwordPatches).toEqual([]);
  const granted = await pool.query('SELECT role FROM company_users WHERE company_id=$1 AND user_id=$2',
    [invitingCompany, existingUser]);
  expect(granted.rows).toEqual([{ role: 'viewer' }]);
  // The membership they already held elsewhere is untouched.
  const original = await pool.query('SELECT role FROM company_users WHERE company_id=$1 AND user_id=$2',
    [existingCompany, existingUser]);
  expect(original.rows).toEqual([{ role: 'owner' }]);
  const inv = await pool.query('SELECT accepted_at FROM company_invitations WHERE id=$1', [inviteId]);
  expect(inv.rows[0].accepted_at).not.toBeNull();
});

it('replaying an accepted invitation token is refused and never patches a password', async () => {
  const result = response();

  await getAccept()(acceptRequest(token, 'attacker-chosen-password-2026', '127.0.0.82'), result.res);

  expect(result.state.statusCode).toBe(410);
  expect(passwordPatches).toEqual([]);
});

it('still sets the password for a brand-new invitee who has no users row yet', async () => {
  const result = response();

  await getAccept()(acceptRequest(newToken, 'new-invitee-password-2026', '127.0.0.84'), result.res);

  expect(result.state.statusCode).toBe(200);
  expect(passwordPatches).toEqual([{ userId: newInvitee, password: 'new-invitee-password-2026' }]);
  const granted = await pool.query('SELECT role FROM company_users WHERE company_id=$1 AND user_id=$2',
    [newInviteeCompany, newInvitee]);
  expect(granted.rows).toEqual([{ role: 'manager' }]);
  const profile = await pool.query('SELECT email FROM users WHERE id=$1', [newInvitee]);
  expect(profile.rows).toEqual([{ email: newEmail }]);
});

it('L6: re-inviting an existing member at a new role changes their role on accept', async () => {
  // Exactly what POST /api/invitations does on a resend: the row is rewritten
  // in place by ON CONFLICT (company_id, email). The member already exists in
  // this company as a viewer from the test above.
  await pool.query(
    `UPDATE company_invitations
     SET role='manager', token=$2, expires_at=now()+interval '7 days', accepted_at=NULL
     WHERE id=$1`,
    [inviteId, stored(cappedToken + 'role')]);
  const result = response();

  await getAccept()(acceptRequest(cappedToken + 'role', REAL_PASSWORD, '127.0.0.86'), result.res);

  expect(result.state.statusCode).toBe(200);
  // ON CONFLICT DO NOTHING left the old role in place while the invitation
  // claimed the new one.
  const granted = await pool.query('SELECT role FROM company_users WHERE company_id=$1 AND user_id=$2',
    [invitingCompany, existingUser]);
  expect(granted.rows).toEqual([{ role: 'manager' }]);
});

it('L4: the accept endpoint caps password attempts per invitation token', async () => {
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now()+interval '7 days', $5)`,
    [cappedCompany, email, inviter, stored(cappedToken), existingUser]);

  const statuses: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    const result = response();
    await getAccept()(acceptRequest(cappedToken, `wrong-guess-number-${i}-2026`, '127.0.0.88'), result.res);
    statuses.push(result.state.statusCode as number);
  }

  // Ten guesses are refused as wrong passwords; the rest never reach GoTrue.
  expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
  expect(statuses.slice(10)).toEqual([429, 429]);
  // No guess ever set a password, and no membership was granted. A wrong
  // password is exactly what the cap bounds, so none of the twelve is refunded.
  expect(passwordPatches).toEqual([{ userId: newInvitee, password: 'new-invitee-password-2026' }]);
  const granted = await pool.query('SELECT 1 FROM company_users WHERE company_id=$1 AND user_id=$2',
    [cappedCompany, existingUser]);
  expect(granted.rowCount).toBe(0);
});

it('L5: an established account whose password predates the 10-character floor can still accept', async () => {
  const result = response();

  await getAccept()(acceptRequest(shortPwToken, SHORT_PASSWORD, '127.0.0.90'), result.res);

  // The floor is a rule about SETTING a password. Here it is proof of ownership
  // of an account that already exists, so it must not be applied.
  expect(result.state.statusCode).toBe(200);
  expect(passwordPatches.some((p) => p.userId === shortPwUser)).toBe(false);
  const granted = await pool.query('SELECT role FROM company_users WHERE company_id=$1 AND user_id=$2',
    [shortPwCompany, shortPwUser]);
  expect(granted.rows).toEqual([{ role: 'viewer' }]);
});

it('L5 adjacent: a brand-new invitee is still held to ten characters', async () => {
  // A second brand-new invitee: the first one's invitation is already accepted.
  const freshUser = crypto.randomUUID();
  const freshToken = `k041f${'0'.repeat(27)}${freshUser.replace(/-/g, '')}`;
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now()+interval '7 days', $5)`,
    [newInviteeCompany, `k041f-${freshUser}@test.local`, inviter, stored(freshToken), freshUser]);
  const result = response();

  await getAccept()(acceptRequest(freshToken, 'short', '127.0.0.91'), result.res);

  expect(result.state.statusCode).toBe(400);
  expect(result.state.body).toMatchObject({ error: { code: 'WEAK_PASSWORD' } });
  expect(passwordPatches.some((p) => p.userId === freshUser)).toBe(false);
});

it('L4: an unknown token is refused without minting a rate-limit row for it', async () => {
  const bogus = `k041x${'0'.repeat(27)}${crypto.randomUUID().replace(/-/g, '')}`;
  const result = response();

  await getAccept()(acceptRequest(bogus, 'attacker-chosen-password-2026', '127.0.0.92'), result.res);

  expect(result.state.statusCode).toBe(410);
  // The key is a digest of a caller-chosen URL segment, so charging the limiter
  // before the lookup let an unauthenticated caller insert one row per invented
  // token. Only a token that resolves to a real invitation may create one.
  const counters = await pool.query('SELECT 1 FROM rate_limit_counters WHERE key=$1',
    [`invite-accept:${stored(bogus)}`]);
  expect(counters.rowCount).toBe(0);
});

it('L3: an attempt that dies inside GoTrue is still counted against the invitation', async () => {
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now()+interval '7 days', $5)`,
    [shortPwCompany, `k041o-${outageUser}@test.local`, inviter, stored(outageToken), outageUser]);
  const result = response();

  issued.length = 0;
  setRecording(true);
  try {
    await getAccept()(acceptRequest(outageToken, 'outage-password-2026', '127.0.0.93'), result.res);
  } finally {
    setRecording(false);
  }

  // Round-3 L7: the route is wrapped in withErrorHandler now, so a GoTrue
  // outage answers JSON rather than escaping as a bare Next HTML 500 that
  // pages/accept-invite.tsx cannot parse (it reported "Network error" for
  // every server fault). withErrorHandler sits OUTSIDE withInviteToken, so the
  // invite-token transaction is still rolled back before this is written.
  expect(result.state.statusCode).toBe(500);
  expect(result.state.body).toMatchObject({ success: false, code: 'INTERNAL_SERVER_ERROR' });

  // Round-3 L1: the GoTrue call that threw runs BEFORE the admin client opens a
  // transaction. Without `if (opened)` this request issues a bare ROLLBACK on a
  // client with nothing to roll back, logging a WARNING on every GoTrue
  // failure. The admin client is the one that read `users`.
  const adminClientId = issued.find((q) => q.sql.includes('FROM users WHERE id'))?.clientId;
  expect(adminClientId).toBeDefined();
  const adminSql = issued.filter((q) => q.clientId === adminClientId)
    .map((q) => q.sql.trim().toUpperCase());
  expect(adminSql).not.toContain('ROLLBACK');
  expect(adminSql).not.toContain('BEGIN');

  // checkRateLimit writes through `sql`, which routes onto the invite-token
  // transaction when one is in flight — and withInviteToken ROLLBACKs that
  // transaction on a throw, taking the attempt with it. Run on the module pool
  // the count survives, which is what "counted exactly" has to mean for a
  // limiter whose whole job is to bound guesses that fail. Nor is it refunded:
  // an outage is not a verdict reached after a successful sign-in.
  const counters = await pool.query('SELECT count FROM rate_limit_counters WHERE key=$1',
    [`invite-accept:${stored(outageToken)}`]);
  expect(counters.rows).toEqual([{ count: 2 }]);
});
