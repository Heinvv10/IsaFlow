/**
 * K-041 adjacent cases — the conditions later review rounds found reachable on
 * the same anonymous accept surface. Split out of
 * k-041-invite-accept-overwrites-existing-password.int.test.ts, which had grown
 * past the 300-line ceiling in CLAUDE.md; the fixture and GoTrue stub are the
 * shared ./k-041-invite-accept.helpers module, imported per worker so the two
 * files never share a row.
 *
 * Covered here: an invited address already held by another `users` row; an
 * established profile email surviving acceptance; hostile names from the
 * anonymous body; a name of astral characters cut mid-surrogate-pair; the
 * `email_confirm` an unverified pending signup needs; and the rate-limit units
 * handed back on a verdict that is not a password guess.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { response } from './mfa-impersonation-postgres.helpers';
import {
  L4_PASSWORD, acceptRequest, adminPatches, astralEmail, astralToken, astralUser, extraAccounts,
  getAccept, inviter, l3Email, l3Legacy, l3Token, l3User, l4Changed, l4Invited, l4Token, l4User,
  l5Email, l5Token, l5User, newInviteeCompany, pool, setupInviteFixture, shortPwCompany, stored,
  teardownInviteFixture,
} from './k-041-invite-accept.helpers';

beforeAll(setupInviteFixture);
afterAll(teardownInviteFixture);

it('L3: an address already held by another users row is refused, not 500ed', async () => {
  // The invitee is brand-new (no `users` row for their GoTrue id), but the
  // address they were invited at already belongs to a different profile row.
  // `ON CONFLICT (id)` cannot see that conflict: users_email_key raises 23505,
  // which escaped as an opaque 500 and rolled the acceptance back with no
  // explanation the invitee could act on. It is now answered from the
  // violation itself, so the concurrent case answers the same 409 the
  // pre-existing one does.
  await pool.query("INSERT INTO users(id,email,is_active) VALUES($1,$2,true)", [l3Legacy, l3Email]);
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now()+interval '7 days', $5)`,
    [shortPwCompany, l3Email, inviter, stored(l3Token), l3User]);
  extraAccounts.set(l3Email, { id: l3User, password: 'low3-invitee-password-2026' });
  const result = response();

  await getAccept()(acceptRequest(l3Token, 'low3-invitee-password-2026', '127.0.0.94'), result.res);

  expect(result.state.statusCode).toBe(409);
  expect(result.state.body).toMatchObject({ error: { code: 'EMAIL_IN_USE' } });
  // The whole acceptance is rolled back: no membership, no profile row for the
  // new id, and the invitation is still open once an admin resolves the clash.
  const granted = await pool.query('SELECT 1 FROM company_users WHERE company_id=$1 AND user_id=$2',
    [shortPwCompany, l3User]);
  expect(granted.rowCount).toBe(0);
  const profile = await pool.query('SELECT 1 FROM users WHERE id=$1', [l3User]);
  expect(profile.rowCount).toBe(0);
  const inv = await pool.query('SELECT accepted_at FROM company_invitations WHERE token=$1', [stored(l3Token)]);
  expect(inv.rows[0].accepted_at).toBeNull();
  // The legacy row is untouched — the conflict is reported, never resolved by
  // overwriting somebody else's profile.
  const legacy = await pool.query('SELECT email FROM users WHERE id=$1', [l3Legacy]);
  expect(legacy.rows).toEqual([{ email: l3Email }]);
  // Round-6 L7: the two units this attempt cost are handed back. The verdict is
  // permanent and only reachable after signIn already succeeded, so charging it
  // locked the rightful invitee out of their own link for an hour over a defect
  // in somebody else's data.
  const counters = await pool.query('SELECT count FROM rate_limit_counters WHERE key=$1',
    [`invite-accept:${stored(l3Token)}`]);
  expect(counters.rows).toEqual([{ count: 0 }]);
});

it('L7: a signed-in identity that does not match the invitation is refunded too', async () => {
  // The invitation names one GoTrue id; the credentials that sign in belong to
  // another. Nothing here is a password guess — the password was right.
  const mismatchInvited = crypto.randomUUID();
  const mismatchSignedIn = crypto.randomUUID();
  const mismatchEmail = `k041mm-${mismatchInvited}@test.local`;
  const mismatchToken = `k041B${'0'.repeat(27)}${mismatchInvited.replace(/-/g, '')}`;
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now()+interval '7 days', $5)`,
    [shortPwCompany, mismatchEmail, inviter, stored(mismatchToken), mismatchInvited]);
  extraAccounts.set(mismatchEmail, { id: mismatchSignedIn, password: 'mismatch-password-2026' });
  const result = response();

  await getAccept()(acceptRequest(mismatchToken, 'mismatch-password-2026', '127.0.0.97'), result.res);

  expect(result.state.statusCode).toBe(409);
  expect(result.state.body).toMatchObject({ error: { code: 'IDENTITY_MISMATCH' } });
  // Refunded to exactly zero: GREATEST(count - cost, 0) can never drive the
  // shared counter negative, and the refund leaves window_start alone.
  const counters = await pool.query('SELECT count FROM rate_limit_counters WHERE key=$1',
    [`invite-accept:${stored(mismatchToken)}`]);
  expect(counters.rows).toEqual([{ count: 0 }]);
});

it('L4: accepting an invitation does not revert an established profile email', async () => {
  await pool.query("INSERT INTO users(id,email,is_active) VALUES($1,$2,true)", [l4User, l4Changed]);
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'manager',$3,$4, now()+interval '7 days', $5)`,
    [newInviteeCompany, l4Invited, inviter, stored(l4Token), l4User]);
  extraAccounts.set(l4Invited, { id: l4User, password: L4_PASSWORD });
  const result = response();

  await getAccept()(acceptRequest(l4Token, L4_PASSWORD, '127.0.0.95'), result.res);

  expect(result.state.statusCode).toBe(200);
  // `DO UPDATE SET email = EXCLUDED.email` rewrote this to the invited address
  // on every acceptance, silently undoing a profile email the user had changed.
  const profile = await pool.query('SELECT email FROM users WHERE id=$1', [l4User]);
  expect(profile.rows).toEqual([{ email: l4Changed }]);
  const granted = await pool.query('SELECT role FROM company_users WHERE company_id=$1 AND user_id=$2',
    [newInviteeCompany, l4User]);
  expect(granted.rows).toEqual([{ role: 'manager' }]);
});

it('L5: names from the anonymous body are type-checked and bounded', async () => {
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now()+interval '7 days', $5)`,
    [shortPwCompany, l5Email, inviter, stored(l5Token), l5User]);
  extraAccounts.set(l5Email, { id: l5User, password: 'low5-invitee-password-2026' });
  const result = response();

  // A non-string bound as JSON text; a 400-character string raised 22001
  // against users.last_name VARCHAR(255) and escaped as a 500.
  await getAccept()(acceptRequest(l5Token, 'low5-invitee-password-2026', '127.0.0.96',
    { firstName: 12345, lastName: 'x'.repeat(400) }), result.res);

  expect(result.state.statusCode).toBe(200);
  const profile = await pool.query<{ first_name: string | null; last_name: string | null }>(
    'SELECT first_name, last_name FROM users WHERE id=$1', [l5User]);
  expect(profile.rows[0]!.first_name).toBeNull();
  expect(profile.rows[0]!.last_name).toHaveLength(255);
});

it('M1: a name of astral characters is cut on a code point, not mid-surrogate-pair', async () => {
  // `String.prototype.slice` counts UTF-16 code units, so a 255-unit cut of a
  // string built from surrogate pairs ends on a lone high surrogate. Postgres
  // refuses that as `22021 invalid byte sequence for encoding "UTF8"` — the
  // same 500 the length cap exists to remove, and worse than the 22001 it
  // replaced, because it fires AFTER the password has been set and the sign-in
  // has succeeded: the credential change persists, the membership does not.
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now()+interval '7 days', $5)`,
    [shortPwCompany, astralEmail, inviter, stored(astralToken), astralUser]);
  extraAccounts.set(astralEmail, { id: astralUser, password: 'astral-invitee-password-2026' });
  const result = response();

  await getAccept()(acceptRequest(astralToken, 'astral-invitee-password-2026', '127.0.0.98',
    { firstName: '\u{1F44D}'.repeat(300), lastName: 'Astral' }), result.res);

  expect(result.state.statusCode).toBe(200);
  const profile = await pool.query<{ first_name: string }>(
    'SELECT first_name FROM users WHERE id=$1', [astralUser]);
  const storedName = profile.rows[0]!.first_name;
  // 255 whole code points — 510 UTF-16 code units — and VARCHAR(255) accepts it
  // because Postgres counts characters, not units.
  expect([...storedName]).toHaveLength(255);
  expect(storedName).toBe('\u{1F44D}'.repeat(255));
  // No lone surrogate survived the cut.
  expect(/[\uD800-\uDFFF]/.test(storedName.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(false);
});

it('M2: a brand-new invitee is confirmed as well as given a password', async () => {
  // adminCreateUser returns early through adminGetUserByEmail on a 422 and
  // never applies the `email_confirm: true` POST /api/invitations passes it
  // (src/lib/auth/gotrue.ts). An address with a pending, unverified
  // /api/auth/register signup is exactly that case: no `users` row, so this
  // path runs, but a GoTrue user that already exists unconfirmed. Without
  // email_confirm here the password is overwritten and the signIn that follows
  // fails `email_not_confirmed`, rethrows, and answers 500 on every retry.
  const confirmUser = crypto.randomUUID();
  const confirmEmail = `k041c2-${confirmUser}@test.local`;
  const confirmToken = `k041C${'0'.repeat(27)}${confirmUser.replace(/-/g, '')}`;
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now()+interval '7 days', $5)`,
    [shortPwCompany, confirmEmail, inviter, stored(confirmToken), confirmUser]);
  extraAccounts.set(confirmEmail, { id: confirmUser, password: 'confirm-invitee-password-2026' });
  const result = response();

  await getAccept()(acceptRequest(confirmToken, 'confirm-invitee-password-2026', '127.0.0.99'), result.res);

  expect(result.state.statusCode).toBe(200);
  const patch = adminPatches.find((p) => p.userId === confirmUser);
  expect(patch).toBeDefined();
  expect(patch!.body.email_confirm).toBe(true);
  expect(patch!.body.password).toBe('confirm-invitee-password-2026');
  await pool.query('DELETE FROM company_users WHERE user_id=$1', [confirmUser]);
  await pool.query('DELETE FROM users WHERE id=$1', [confirmUser]);
});
