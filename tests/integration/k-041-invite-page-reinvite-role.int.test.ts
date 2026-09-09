/**
 * Round-2 M2: the OTHER acceptance route kept the old role on a re-invite.
 *
 * pages/api/invitations/[token]/accept.ts was fixed to ON CONFLICT DO UPDATE so
 * that re-inviting an existing member at a new role actually changes it. Its
 * sibling POST /api/invite/[token] accepts the SAME company_invitations rows —
 * POST /api/invitations rewrites `role` in place, and nothing stops a signed-in
 * member from opening /invite/<token> for a token minted by that route — but it
 * still did DO NOTHING, so the claim held on one route and not the other.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const member = crypto.randomUUID();
const inviter = crypto.randomUUID();
const email = `k041m-${member}@test.local`;
const rawToken = `k041m${'0'.repeat(27)}${member.replace(/-/g, '')}`;
const inviteId = crypto.randomUUID();
const csrf = 'disposable-postgres-workflow-csrf-0123456789';

const stored = (raw: string) => createHash('sha256').update(raw).digest('hex');

async function acceptAtInvitePage(token: string) {
  const { SignJWT } = await import('jose');
  const jwt = await new SignJWT({ sub: member, email, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const cookies = { 'sb-access-token': jwt, isaflow_csrf: csrf };
  const handler = (await import('../../pages/api/invite/[token]')).default;
  const result = response();
  await handler({
    method: 'POST', url: `/api/invite/${token}`, query: { token }, cookies, body: {},
    headers: {
      cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      'x-csrf-token': csrf,
    },
    socket: { remoteAddress: '127.0.0.90' },
  } as never, result.res);
  return result;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K041 M2 company']);
  await pool.query(
    "INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true),($3,$4,'admin',true)",
    [member, email, inviter, `k041m-inviter-${inviter}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'viewer'),($1,$3,'owner')",
    [company, member, inviter]);
  // A re-invite of that existing viewer, at a higher role — exactly the row
  // POST /api/invitations writes on ON CONFLICT (company_id, email).
  await pool.query(
    `INSERT INTO company_invitations(id,company_id,email,role,invited_by,token,expires_at)
     VALUES($1,$2,$3,'manager',$4,$5, now()+interval '7 days')`,
    [inviteId, company, email, inviter, stored(rawToken)]);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  try {
    await pool.query('DELETE FROM company_invitations WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [[member, inviter]]);
  } finally { await pool.end(); }
});

it('M2: /api/invite/<token> raises an existing member to the re-invited role', async () => {
  const result = await acceptAtInvitePage(rawToken);

  expect(result.state.statusCode).toBe(200);
  const granted = await pool.query('SELECT role FROM company_users WHERE company_id=$1 AND user_id=$2',
    [company, member]);
  expect(granted.rows).toEqual([{ role: 'manager' }]);
  const inv = await pool.query('SELECT accepted_at FROM company_invitations WHERE id=$1', [inviteId]);
  expect(inv.rows[0].accepted_at).not.toBeNull();
});

it('M2 adjacent: an invitation addressed to someone else is refused and changes no role', async () => {
  const otherToken = `${rawToken.slice(0, -4)}beef`;
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at)
     VALUES($1,$2,'owner',$3,$4, now()+interval '7 days')`,
    [company, `k041m-stranger-${company}@test.local`, inviter, stored(otherToken)]);

  const result = await acceptAtInvitePage(otherToken);

  expect(result.state.statusCode).toBe(403);
  const granted = await pool.query('SELECT role FROM company_users WHERE company_id=$1 AND user_id=$2',
    [company, member]);
  expect(granted.rows).toEqual([{ role: 'manager' }]);
});

/**
 * Round-3 L6: the acceptance log line carried the RAW 64-hex token. The whole
 * point of src/lib/auth/inviteToken.ts is that the secret never leaves the
 * request — the table holds only its digest — and a log line is exactly where
 * it must not land. Assert on what the logger was actually handed, not on the
 * source text.
 */
it('L6: accepting an invitation never writes the raw token to the log', async () => {
  const freshMember = crypto.randomUUID();
  const freshEmail = `k041l-${freshMember}@test.local`;
  const freshToken = `k041l${'0'.repeat(27)}${freshMember.replace(/-/g, '')}`;
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)",
    [freshMember, freshEmail]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'viewer')",
    [company, freshMember]);
  await pool.query(
    `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at)
     VALUES($1,$2,'manager',$3,$4, now()+interval '7 days')`,
    [company, freshEmail, inviter, stored(freshToken)]);

  const { log } = await import('@/lib/logger');
  const infos: unknown[] = [];
  const spy = vi.spyOn(log, 'info').mockImplementation((...args: unknown[]) => { infos.push(args); });

  const { SignJWT } = await import('jose');
  const jwt = await new SignJWT({ sub: freshMember, email: freshEmail, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const cookies = { 'sb-access-token': jwt, isaflow_csrf: csrf };
  const handler = (await import('../../pages/api/invite/[token]')).default;
  const result = response();
  try {
    await handler({
      method: 'POST', url: `/api/invite/${freshToken}`, query: { token: freshToken }, cookies, body: {},
      headers: {
        cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
        'x-csrf-token': csrf,
      },
      socket: { remoteAddress: '127.0.0.90' },
    } as never, result.res);
  } finally {
    spy.mockRestore();
  }

  expect(result.state.statusCode).toBe(200);
  expect(JSON.stringify(infos)).not.toContain(freshToken);
  // …and the line is still diagnosable: it names the invitation instead.
  const invId = await pool.query('SELECT id FROM company_invitations WHERE token=$1', [stored(freshToken)]);
  expect(JSON.stringify(infos)).toContain(invId.rows[0].id);
});
