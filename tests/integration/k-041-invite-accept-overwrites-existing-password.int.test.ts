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
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import type { NextApiRequest } from 'next';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const invitingCompany = crypto.randomUUID();
const existingCompany = crypto.randomUUID();
const newInviteeCompany = crypto.randomUUID();
const existingUser = crypto.randomUUID();
const newInvitee = crypto.randomUUID();
const inviter = crypto.randomUUID();
const email = `k041-${existingUser}@test.local`;
const newEmail = `k041-new-${newInvitee}@test.local`;
const token = `k041${'0'.repeat(28)}${existingUser.replace(/-/g, '')}`;
const newToken = `k041n${'0'.repeat(27)}${newInvitee.replace(/-/g, '')}`;
const inviteId = crypto.randomUUID();
const newInviteId = crypto.randomUUID();
/** L4: a fourth company, so the attempt-cap test gets its own invitation row. */
const cappedCompany = crypto.randomUUID();
const cappedToken = `k041c${'0'.repeat(27)}${existingUser.replace(/-/g, '')}`;
/**
 * Round-2 L5: an account provisioned before the 10-character floor existed.
 * Its owner must be able to accept an invitation by proving ownership of the
 * password it actually has, not the one our current rule would demand.
 */
const shortPwCompany = crypto.randomUUID();
const shortPwUser = crypto.randomUUID();
const shortPwEmail = `k041s-${shortPwUser}@test.local`;
const shortPwToken = `k041s${'0'.repeat(27)}${shortPwUser.replace(/-/g, '')}`;
const SHORT_PASSWORD = 'short1';
/** Round-2 L3: a brand-new invitee whose GoTrue call blows up mid-accept. */
const outageUser = crypto.randomUUID();
const outageToken = `k041o${'0'.repeat(27)}${outageUser.replace(/-/g, '')}`;

/** company_invitations.token holds sha256 of the token carried by the link. */
const stored = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** The password the pre-existing account already has. Only GoTrue knows it. */
const REAL_PASSWORD = 'existing-real-password-2026';

const passwordPatches: Array<{ userId: string; password?: string }> = [];
const originalFetch = globalThis.fetch;

let accept: typeof import('../../pages/api/invitations/[token]/accept').default;

function acceptRequest(inviteToken: string, password: string, remote: string): NextApiRequest {
  return {
    method: 'POST', url: `/api/invitations/${inviteToken}/accept`, query: { token: inviteToken },
    cookies: {}, headers: {},
    body: { token: inviteToken, password, firstName: 'K', lastName: '041' },
    socket: { remoteAddress: remote },
  } as unknown as NextApiRequest;
}

beforeAll(async () => {
  vi.stubEnv('MIGRATION_ADMIN_DATABASE_URL', process.env.PLATFORM_ADMIN_DATABASE_URL!);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'disposable-service-role-key');
  vi.stubEnv('SUPABASE_ANON_KEY', 'disposable-anon-key');

  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4),($5,$6),($7,$8),($9,$10)',
    [invitingCompany, 'K041 inviting company', existingCompany, 'K041 existing company',
      newInviteeCompany, 'K041 new-invitee company', cappedCompany, 'K041 attempt-cap company',
      shortPwCompany, 'K041 short-password company']);
  // The victim: an account that already exists and already has a password.
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true),($3,$4,'admin',true),($5,$6,'viewer',true)",
    [existingUser, email, inviter, `k041-inviter-${inviter}@test.local`, shortPwUser, shortPwEmail]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')",
    [existingCompany, existingUser, invitingCompany, inviter]);
  await pool.query(
    `INSERT INTO company_invitations(id,company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,$3,'viewer',$4,$5,now()+interval '7 days',$6),
           ($7,$8,$9,'manager',$4,$10,now()+interval '7 days',$11)`,
    [inviteId, invitingCompany, email, inviter, stored(token), existingUser,
      newInviteId, newInviteeCompany, newEmail, stored(newToken), newInvitee]);
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now()+interval '7 days', $5)`,
    [shortPwCompany, shortPwEmail, inviter, stored(shortPwToken), shortPwUser]);

  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('External network forbidden in disposable invite fixture');
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname.startsWith('/admin/users/')) {
      const userId = url.pathname.split('/').pop()!;
      if (userId === outageUser) throw new Error('disposable gotrue outage');
      passwordPatches.push({ userId, password: body.password });
      return new Response(JSON.stringify({ id: userId, email: userId === existingUser ? email : newEmail }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/token') {
      // GoTrue answers 400 for a wrong password. The pre-existing account keeps
      // REAL_PASSWORD; the brand-new one accepts whatever accept.ts just set.
      const isExisting = body.email === email;
      const isShortPw = body.email === shortPwEmail;
      const patched = passwordPatches.find((p) => p.userId === newInvitee)?.password;
      const ok = isExisting ? body.password === REAL_PASSWORD
        : isShortPw ? body.password === SHORT_PASSWORD
          : body.password === patched;
      if (!ok) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }),
          { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        access_token: 'disposable-access', refresh_token: 'disposable-refresh',
        expires_in: 3600, token_type: 'bearer',
        user: { id: isExisting ? existingUser : isShortPw ? shortPwUser : newInvitee, email: body.email },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  });

  accept = (await import('../../pages/api/invitations/[token]/accept')).default;
});

afterAll(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  const companies = [invitingCompany, existingCompany, newInviteeCompany, cappedCompany, shortPwCompany];
  try {
    await pool.query('DELETE FROM company_invitations WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [[existingUser, inviter, newInvitee, shortPwUser]]);
    await pool.query('DELETE FROM rate_limit_counters WHERE key LIKE $1', ['invite-accept:%']);
  } finally { await pool.end(); }
});

it('does NOT reset an already-registered account password when its invitation is accepted', async () => {
  const result = response();

  await accept(acceptRequest(token, 'attacker-chosen-password-2026', '127.0.0.82'), result.res);

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

  await accept(acceptRequest(token, REAL_PASSWORD, '127.0.0.82'), result.res);

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

  await accept(acceptRequest(token, 'attacker-chosen-password-2026', '127.0.0.82'), result.res);

  expect(result.state.statusCode).toBe(410);
  expect(passwordPatches).toEqual([]);
});

it('still sets the password for a brand-new invitee who has no users row yet', async () => {
  const result = response();

  await accept(acceptRequest(newToken, 'new-invitee-password-2026', '127.0.0.84'), result.res);

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

  await accept(acceptRequest(cappedToken + 'role', REAL_PASSWORD, '127.0.0.86'), result.res);

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
    await accept(acceptRequest(cappedToken, `wrong-guess-number-${i}-2026`, '127.0.0.88'), result.res);
    statuses.push(result.state.statusCode as number);
  }

  // Ten guesses are refused as wrong passwords; the rest never reach GoTrue.
  expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
  expect(statuses.slice(10)).toEqual([429, 429]);
  // No guess ever set a password, and no membership was granted.
  expect(passwordPatches).toEqual([{ userId: newInvitee, password: 'new-invitee-password-2026' }]);
  const granted = await pool.query('SELECT 1 FROM company_users WHERE company_id=$1 AND user_id=$2',
    [cappedCompany, existingUser]);
  expect(granted.rowCount).toBe(0);
});

it('L5: an established account whose password predates the 10-character floor can still accept', async () => {
  const result = response();

  await accept(acceptRequest(shortPwToken, SHORT_PASSWORD, '127.0.0.90'), result.res);

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

  await accept(acceptRequest(freshToken, 'short', '127.0.0.91'), result.res);

  expect(result.state.statusCode).toBe(400);
  expect(result.state.body).toMatchObject({ error: { code: 'WEAK_PASSWORD' } });
  expect(passwordPatches.some((p) => p.userId === freshUser)).toBe(false);
});

it('L4: an unknown token is refused without minting a rate-limit row for it', async () => {
  const bogus = `k041x${'0'.repeat(27)}${crypto.randomUUID().replace(/-/g, '')}`;
  const result = response();

  await accept(acceptRequest(bogus, 'attacker-chosen-password-2026', '127.0.0.92'), result.res);

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

  await expect(accept(acceptRequest(outageToken, 'outage-password-2026', '127.0.0.93'), result.res))
    .rejects.toThrow('disposable gotrue outage');

  // checkRateLimit writes through `sql`, which routes onto the invite-token
  // transaction when one is in flight — and withInviteToken ROLLBACKs that
  // transaction on a throw, taking the attempt with it. Run on the module pool
  // the count survives, which is what "counted exactly" has to mean for a
  // limiter whose whole job is to bound guesses that fail.
  const counters = await pool.query('SELECT count FROM rate_limit_counters WHERE key=$1',
    [`invite-accept:${stored(outageToken)}`]);
  expect(counters.rows).toEqual([{ count: 2 }]);
});
