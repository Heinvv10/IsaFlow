// K-104: the two invitation systems wrote incompatible encodings into the same
//        company_invitations.token column, and UNIQUE(company_id,email) makes
//        them share one row, so each overwrote the other's live link. sha256 is
//        now the single stored encoding on both sides.
// R-030 (found while validating K-105): pages/api/invitations/[token]/index.ts
//        joins `companies`, whose only read policy is companies_member_read. The
//        invite-token session has no JWT, so the join dropped every row and every
//        valid invitation answered 410 — the whole /accept-invite flow was dead.
//        Migration 648 exposes the one column the endpoint needs through a
//        SECURITY DEFINER function; 643 (now 662) originally added a whole-row policy on companies (163
//        columns, including the Netcash keys and the bank account number) is
//        dropped. K-105's own claim (email leak, expiry ignored) was a false
//        positive; the email is masked here for defence in depth and
//        expiry/acceptance are enforced by RLS.
// H1:    a userInvitationService invitation has no gotrue_user_id, so neither
//        endpoint may treat it as an accept-invite invitation.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';

const sentEmails: Array<{ html: string }> = [];
vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendEmail: vi.fn(async (msg: { html: string }) => { sentEmails.push(msg); return { success: true, messageId: 'disposable' }; }),
}));
const gotrueUserId = crypto.randomUUID();
vi.mock('@/lib/auth/gotrue', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminCreateUser: vi.fn(async () => ({ id: gotrueUserId })),
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const inviter = crypto.randomUUID();
const invitee = `k104-${crypto.randomUUID()}@test.local`;
const freshToken = 'a'.repeat(64);
const expiredToken = 'b'.repeat(64);
const acceptedToken = 'c'.repeat(64);
let jwt = '';

const stored = (raw: string) => createHash('sha256').update(raw).digest('hex');

async function lookup(token: string) {
  const lookupInvitation = (await import('../../pages/api/invitations/[token]/index')).default;
  const req = { method: 'GET', url: `/api/invitations/${token}`, query: { token }, headers: {}, cookies: {} };
  const result = response();
  await lookupInvitation(req as never, result.res);
  return result;
}

async function invite(email: string, role: string) {
  const { SignJWT } = await import('jose');
  jwt ||= await new SignJWT({ sub: inviter, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const invitations = (await import('../../pages/api/invitations/index')).default;
  const csrf = 'disposable-postgres-workflow-csrf-0123456789';
  const cookies = { 'sb-access-token': jwt, active_company_id: company, isaflow_csrf: csrf };
  const req = {
    method: 'POST', url: '/api/invitations', query: {}, cookies,
    headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': csrf },
    body: { email, role }, socket: { remoteAddress: '127.0.0.88' },
  };
  const result = response();
  await invitations(req as never, result.res);
  const html = sentEmails.at(-1)!.html;
  return { result, rawToken: /accept-invite\?token=([0-9a-f]{64})/.exec(html)![1]! };
}

/** What an invite-token session can see, exactly as withInviteToken sets it up. */
async function inviteSession<T>(rawToken: string, run: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('app.invite_token', $1, true)", [stored(rawToken)]);
    return await run(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

beforeAll(async () => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'disposable-service-role-key');
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K104 fixture', otherCompany, 'K104 unrelated company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [inviter, `${inviter}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, inviter]);
  // gotrue_user_id is what POST /api/invitations writes and userInvitationService
  // does not; these three are shaped like the former, and the H1 test below adds
  // one shaped like the latter.
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,accepted_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now() + interval '7 days', NULL, $9),
           ($1,$5,'viewer',$3,$6, now() - interval '1 day', NULL, $9),
           ($1,$7,'viewer',$3,$8, now() + interval '7 days', now(), $9)`,
    [company, `fresh-${invitee}`, inviter, stored(freshToken),
      `expired-${invitee}`, stored(expiredToken), `accepted-${invitee}`, stored(acceptedToken),
      gotrueUserId]);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  try {
    await pool.query('DELETE FROM company_invitations WHERE company_id=ANY($1::uuid[])', [[company, otherCompany]]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[company, otherCompany]]);
    await pool.query('DELETE FROM users WHERE id=$1', [inviter]);
    await pool.query('DELETE FROM rate_limit_counters WHERE key LIKE $1', [`invitations:company:${company}%`]);
  } finally { await pool.end(); }
});

it('K-104: both invitation systems store one encoding, and either link resolves', async () => {
  // System 1: POST /api/invitations. The raw token is mailed, the digest stored.
  const first = await invite(invitee, 'viewer');
  const afterFirst = await pool.query('SELECT token FROM company_invitations WHERE company_id=$1 AND email=$2',
    [company, invitee]);
  expect(afterFirst.rows[0].token).toBe(stored(first.rawToken));
  expect(afterFirst.rows[0].token).not.toBe(first.rawToken);
  expect((await lookup(first.rawToken)).state.statusCode).toBe(200);

  // System 2: userInvitationService, for the SAME address, onto the SAME row.
  const { createInvitation } = await import('../../src/modules/accounting/services/core/userInvitationService');
  const second = await createInvitation(company, invitee, 'viewer', inviter);
  const issued = (second.invitation as { token: string }).token;
  const afterSecond = await pool.query('SELECT token FROM company_invitations WHERE company_id=$1 AND email=$2',
    [company, invitee]);

  // One encoding: what system 2 issued resolves through system 1's lookup.
  expect(afterSecond.rows[0].token).toBe(stored(issued));
  expect((await lookup(issued)).state.statusCode).toBe(200);
  // The superseded link is dead, which is what a resend means — not the silent
  // encoding mismatch that used to kill it while the row still looked live.
  expect((await lookup(first.rawToken)).state.statusCode).toBe(410);
});

it('R-030: a live invitation resolves, with the email masked, and expired or accepted ones do not', async () => {
  const fresh = await lookup(freshToken);
  const data = (fresh.state.body as { data?: { email?: string; company_name?: string } }).data;
  expect({
    freshStatus: fresh.state.statusCode,
    companyName: data?.company_name,
    email: data?.email,
    expiredStatus: (await lookup(expiredToken)).state.statusCode,
    acceptedStatus: (await lookup(acceptedToken)).state.statusCode,
    unknownStatus: (await lookup('d'.repeat(64))).state.statusCode,
  }).toEqual({
    freshStatus: 200,
    companyName: 'K104 fixture',
    email: `f***@test.local`,
    expiredStatus: 410,
    acceptedStatus: 410,
    unknownStatus: 410,
  });
});

it('R-030: the invite session gets the company NAME and no other column of it', async () => {
  const seen = await inviteSession(freshToken, async (c) => ({
    name: (await c.query('SELECT invite_token_company_name() AS n')).rows[0].n,
    // The row itself stays unreadable: migration 648 dropped the whole-row
    // policy the old 643 added, so the 163 columns of `companies` — netcash_service_key,
    // netcash_payouts_key, bank_account_number, bank_branch_code among them —
    // are not exposed to whoever holds an invitation link.
    rows: (await c.query('SELECT id FROM companies')).rows.length,
    secrets: (await c.query(
      'SELECT netcash_service_key, bank_account_number FROM companies')).rows.length,
  }));
  expect(seen).toEqual({ name: 'K104 fixture', rows: 0, secrets: 0 });

  // An unrelated company is never named, and a session with no live invite
  // token gets nothing at all.
  const none = await inviteSession('e'.repeat(64), (c) => c.query('SELECT invite_token_company_name() AS n'));
  expect(none.rows).toEqual([{ n: null }]);
});

it('R-030: an expired invitation exposes neither the invitation nor the company', async () => {
  const rows = await inviteSession(expiredToken, async (c) => ({
    invitations: (await c.query('SELECT id FROM company_invitations')).rows.length,
    companies: (await c.query('SELECT id FROM companies')).rows.length,
    name: (await c.query('SELECT invite_token_company_name() AS n')).rows[0].n,
  }));
  expect(rows).toEqual({ invitations: 0, companies: 0, name: null });
});

it('H1: a userInvitationService invitation is sent to its own flow, not this one', async () => {
  // Same shape createInvitation writes: hashed token, and no gotrue_user_id
  // because that path never creates a GoTrue user. Before the encoding was
  // unified these rows could not match this route at all; now they can.
  const legacyToken = 'f'.repeat(64);
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at,gotrue_user_id)
     VALUES($1,$2,'viewer',$3,$4, now() + interval '7 days', NULL)`,
    [company, `legacy-${invitee}`, inviter, stored(legacyToken)]);

  const looked = await lookup(legacyToken);
  expect({
    status: looked.state.statusCode,
    code: (looked.state.body as { error?: { code?: string } }).error?.code,
  }).toEqual({ status: 409, code: 'WRONG_INVITE_FLOW' });

  // And accept refuses it outright rather than PUTting a password to
  // /admin/users/null, which is what an unguarded gotrue_user_id produced.
  const accept = (await import('../../pages/api/invitations/[token]/accept')).default;
  const req = {
    method: 'POST', url: `/api/invitations/${legacyToken}/accept`, query: { token: legacyToken },
    headers: {}, cookies: {}, body: { password: 'a-perfectly-fine-password' },
    socket: { remoteAddress: '127.0.0.90' },
  };
  const result = response();
  await accept(req as never, result.res);
  expect({
    status: result.state.statusCode,
    code: (result.state.body as { error?: { code?: string } }).error?.code,
  }).toEqual({ status: 410, code: 'INVALID_OR_EXPIRED' });
});

it('round-2 L2: the SECURITY DEFINER function pins pg_catalog first and is not owned by a superuser', async () => {
  const meta = await pool.query<{ owner: string; superuser: boolean; config: string[] | null }>(
    `SELECT r.rolname AS owner, r.rolsuper AS superuser, p.proconfig AS config
     FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.proname = 'invite_token_company_name'`);

  // The body qualifies its tables but not now(), current_setting() or its
  // operators. With `public` ahead of the catalog, any role holding CREATE on
  // public could shadow one of those and have it executed with the definer's
  // rights — and 648 created the function as `postgres`, so those rights were
  // a superuser's. Migration 663 pins the catalog and hands ownership to
  // migration_admin, whose rolbypassrls is the only privilege the body needs.
  expect(meta.rows).toEqual([
    { owner: 'migration_admin', superuser: false, config: ['search_path=pg_catalog, public'] },
  ]);
});

it('round-2 L2 adjacent: hardening the function did not break what it answers', async () => {
  const answered = await inviteSession(freshToken, async (c) =>
    (await c.query<{ name: string | null }>('SELECT invite_token_company_name() AS name')).rows[0]!.name);
  const expired = await inviteSession(expiredToken, async (c) =>
    (await c.query<{ name: string | null }>('SELECT invite_token_company_name() AS name')).rows[0]!.name);

  // Still reads through FORCE RLS on `companies` for the session's own digest,
  // and still says nothing about an invitation that is no longer live.
  expect({ answered, expired }).toEqual({ answered: 'K104 fixture', expired: null });
});
