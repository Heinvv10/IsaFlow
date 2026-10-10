/**
 * R-035 N1b (C) fixture: a company with two owners, an admin, a manager and
 * an outsider; signed tokens (with an email claim, as GoTrue issues them);
 * the real routes; and the /invite/<token> acceptance as the invitee.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { SignJWT } from 'jose';
import companyUsersRoute from '../../pages/api/accounting/company-users';
import companyInvitationsRoute from '../../pages/api/accounting/company-invitations';
import { response } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { cleanupPr2 } from './r035-pr2.helpers';

export type People = { o: string; o2: string; a: string; m: string; x: string };
const CSRF = 'disposable-postgres-workflow-csrf-0123456789';

export const emailOf = (id: string) => `n1bc-${id}@test.local`;
export const tokenHash = (raw: string) => createHash('sha256').update(raw).digest('hex');

export const jwtFor = (id: string) => new SignJWT({ sub: id, email: emailOf(id), aal: 'aal2', session_id: crypto.randomUUID() })
  .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

/** Users o, o2 (owners), a (admin), m (manager), x (no member yet). */
export async function people(pool: Pool, users: string[]): Promise<People> {
  const p = { o: crypto.randomUUID(), o2: crypto.randomUUID(), a: crypto.randomUUID(), m: crypto.randomUUID(), x: crypto.randomUUID() };
  for (const id of Object.values(p)) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [id, emailOf(id)]);
    users.push(id);
  }
  return p;
}

/** A company; `members` defaults to o and o2 owners, a admin, m manager. */
export async function company(pool: Pool, p: People, companies: string[], members?: [string, string][]): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, `N1b C ${id.slice(0, 8)}`]);
  for (const [user, role] of members ?? [[p.o, 'owner'], [p.o2, 'owner'], [p.a, 'admin'], [p.m, 'manager']]) {
    await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [id, user, role]);
  }
  companies.push(id);
  return id;
}

export const roleOf = async (pool: Pool, c: string, user: string) => ((await pool.query(
  'SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [c, user])).rows[0]?.role ?? null) as string | null;

export async function routes(as: string, c: string) {
  const token = await jwtFor(as);
  return {
    members: (method: string, body: unknown) => callRoute(companyUsersRoute, token, c, method, body, '/api/accounting/company-users'),
    invitations: (method: string, body: unknown) =>
      callRoute(companyInvitationsRoute, token, c, method, body, '/api/accounting/company-invitations'),
  };
}

/** POST /api/invite/<token> as the signed-in invitee `who`. */
export async function acceptAsInvitee(who: string, rawToken: string) {
  const jwt = await jwtFor(who);
  const cookies = { 'sb-access-token': jwt, isaflow_csrf: CSRF };
  const handler = (await import('../../pages/api/invite/[token]')).default;
  const result = response();
  await handler({
    method: 'POST', url: `/api/invite/${rawToken}`, query: { token: rawToken }, cookies, body: {},
    headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': CSRF },
    socket: { remoteAddress: '127.0.0.91' },
  } as never, result.res);
  return result;
}

export async function cleanupMembers(pool: Pool, companies: string[], users: string[]): Promise<void> {
  await pool.query('DELETE FROM company_invitations WHERE company_id = ANY($1)', [companies]);
  // create_company_with_owner seeds a chart and periods: the PR2 cleanup clears the ledger tables too.
  await cleanupPr2(pool, companies, users);
}
