/**
 * Fixture for admin-delete-user-invitations*.int.test.ts (follow-up A, 2026-11-16): an admin deletes a user, whose
 * GoTrue sign-in is left alone (decision 2a.1), and the invitations still pending for their address must not let them
 * back in through either accept route.
 *
 * Real routes on the disposable schema fixture, each pool as the role it has in production: the admin portal's
 * request transaction as `platform_admin`, the two accept routes' pool as `migration_admin` (both reached with
 * `options=-c role=`, as admin-user-lock-order.int.test.ts does). GoTrue is a fetch stub that knows the accounts
 * this file creates; it never reaches the network, and no email is sent (invitation rows are written directly, or
 * by createInvitation, which mails nothing).
 */
import { vi } from 'vitest';
import pg, { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { hashInviteToken } from '@/lib/auth/inviteToken';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { assertDisposable, gotruePath, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
export const asRoleUrl = (role: string): string => {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('options', `-c role=${role}`);
  return url.toString();
};
process.env.PLATFORM_ADMIN_DATABASE_URL = asRoleUrl('platform_admin');
process.env.MIGRATION_ADMIN_DATABASE_URL = asRoleUrl('migration_admin');
process.env.SUPABASE_SERVICE_ROLE_KEY = 'disposable-service-role-key';
process.env.SUPABASE_ANON_KEY = 'disposable-anon-key';

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
export const admin = crypto.randomUUID();
/** Owner of every company below: invitations are sent by them, never by the user being deleted. */
export const inviter = crypto.randomUUID();
export const companies = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] as const;
const created: string[] = [];
const digests: string[] = [];
const ips: string[] = [];
/** GoTrue accounts by lower-cased address. Every user this file makes has one, deleted or not. */
const accounts = new Map<string, string>();
/** Each account's GoTrue login address by id (what GET /admin/users/<id> answers). */
const logins = new Map<string, string>();
/** Account ids whose GoTrue admin read, or addresses whose GoTrue lookup, answers 503 (an outage). */
export const gotrueDown = new Set<string>();
/** GoTrue's login address for `id` moves to `email` (change-email); users.email is not touched. */
export function setGotrueEmail(id: string, email: string): void {
  for (const [address, owner] of accounts) if (owner === id) accounts.delete(address);
  accounts.set(email.trim().toLowerCase(), id);
  logins.set(id, email);
}
/** user_metadata GoTrue stored on the accounts it created (POST /admin/users): invite_id names the invitation. */
const metadata = new Map<string, unknown>();
/** GoTrue users whose password an accept route set (PUT /admin/users/<id>). */
export const passwordSets: string[] = [];
let ipSeq = 0;

type Route = (req: never, res: never) => Promise<unknown>;
export type Answer = { status: number; body: { success?: boolean; error?: { code?: string; message?: string } } };

/** A user with a GoTrue account, member (viewer) of each company in `memberOf`. Email defaults to `<id>@test.local`. */
export async function seedUser(opts: { memberOf?: readonly string[]; email?: string } = {}): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID();
  const email = opts.email ?? `${id}@test.local`;
  created.push(id);
  accounts.set(email.trim().toLowerCase(), id);
  logins.set(id, email);
  await pool.query(`INSERT INTO users (id, email, role, is_active, status) VALUES ($1, $2, 'viewer', true, 'active')`, [id, email]);
  for (const company of opts.memberOf ?? []) {
    await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [company, id]);
  }
  return { id, email };
}

/** A pending invitation (the raw token, as mailed). `gotrueUserId` as POST /api/invitations stamps it. */
export async function invite(company: string, email: string, opts: {
  gotrueUserId?: string; acceptedAt?: string; expired?: boolean; role?: string;
} = {}): Promise<string> {
  const raw = `delinv-${crypto.randomUUID()}`;
  digests.push(hashInviteToken(raw));
  await pool.query(
    `INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at, accepted_at, gotrue_user_id)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval, $7, $8)`,
    [company, email, opts.role ?? 'manager', inviter, hashInviteToken(raw), opts.expired ? '-1' : '7',
      opts.acceptedAt ?? null, opts.gotrueUserId ?? null]);
  return raw;
}

/** Records a token another path minted (createInvitation), so teardown finds its rate-limit counters. */
export function trackToken(raw: string): void { digests.push(hashInviteToken(raw)); }

/** DELETE /api/admin/users/<id> as a super admin (aal2, no GoTrue round trip). */
export async function adminDelete(userId: string): Promise<Answer> {
  const route = (await import('../../pages/api/admin/users/[id]')).default;
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, 'DELETE') as unknown as { body: unknown; url: string; query: Record<string, string> };
  req.query = { id: userId };
  req.url = '/api/admin/users/x';
  const result = response();
  await (route as unknown as Route)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as Answer['body'] };
}

/** POST /api/invite/<token>, signed in as `userId` (session email `<id>@test.local`, as signSession mints). */
export async function legacyAccept(userId: string, raw: string): Promise<Answer> {
  const route = (await import('../../pages/api/invite/[token]')).default;
  const jar = { 'sb-access-token': await signSession(userId, crypto.randomUUID(), 'aal2') };
  const req = request(jar, 'POST') as unknown as { body: unknown; query: Record<string, string> };
  req.query = { token: raw };
  req.body = {};
  const result = response();
  await (route as unknown as Route)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as Answer['body'] };
}

/** POST /api/invitations/<token>/accept with a password (anonymous; GoTrue is the stub below). */
export async function newAccept(raw: string): Promise<Answer> {
  const route = (await import('../../pages/api/invitations/[token]/accept')).default;
  ipSeq += 1;
  const ip = `10.86.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
  ips.push(ip);
  const req = {
    method: 'POST', url: `/api/invitations/${raw}/accept`, query: { token: raw }, cookies: {}, headers: {},
    body: { token: raw, password: 'delinv-new-password-2026', firstName: 'Del', lastName: 'Inv' },
    socket: { remoteAddress: ip },
  } as unknown as NextApiRequest;
  const result = response();
  await (route as unknown as Route)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as Answer['body'] };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** GoTrue as the accept route uses it: factor reads (none), the admin password set, and the password grant. */
function gotrueStub(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error(`delinv: external fetch refused: ${url.hostname}`);
  const path = gotruePath(url);
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  if (path === '/user') return Promise.resolve(json({ id: 'disposable', factors: [] }));
  if (path === '/admin/users' && method === 'GET') {
    // findUserByEmail: GoTrue's free-text filter over addresses; the caller exact-matches.
    const filter = (url.searchParams.get('filter') ?? '').toLowerCase();
    if (gotrueDown.has(filter.trim())) return Promise.resolve(json({ msg: 'unavailable' }, 503));
    const users = [...logins].filter(([, email]) => email.toLowerCase().includes(filter.trim())).map(([id, email]) => ({ id, email }));
    return Promise.resolve(json({ users }));
  }
  if (path === '/admin/users' && method === 'POST') {
    // adminCreateUser: a new account for an address no account holds (422 when one does).
    const email = String(body.email);
    if (accounts.has(email.trim().toLowerCase())) return Promise.resolve(json({ msg: 'already registered' }, 422));
    const id = crypto.randomUUID();
    created.push(id);
    accounts.set(email.trim().toLowerCase(), id);
    logins.set(id, email);
    metadata.set(id, body.user_metadata ?? {});
    return Promise.resolve(json({ id, email, user_metadata: metadata.get(id) }));
  }
  if (path.startsWith('/admin/users/') && method === 'GET') {
    // GoTrue parses the id as a UUID, so any letter case names the same (lower-case) account.
    const id = decodeURIComponent(path.split('/').pop()!).toLowerCase();
    if (gotrueDown.has(id)) return Promise.resolve(json({ msg: 'unavailable' }, 503));
    const email = logins.get(id);
    return Promise.resolve(email === undefined ? json({ msg: 'User not found' }, 404)
      : json({ id, email, factors: [], user_metadata: metadata.get(id) ?? {} }));
  }
  if (path.startsWith('/admin/users/')) {
    const id = path.split('/').pop()!;
    passwordSets.push(id);
    return Promise.resolve(json({ id }));
  }
  if (path === '/token') {
    const id = accounts.get(String(body.email).trim().toLowerCase());
    if (!id) return Promise.resolve(json({ error: 'invalid_grant' }, 400));
    return Promise.resolve(json({
      access_token: 'disposable-access', refresh_token: 'disposable-refresh', expires_in: 3600, token_type: 'bearer',
      user: { id, email: body.email },
    }));
  }
  throw new Error(`delinv: unexpected GoTrue call ${method} ${path}`);
}

export async function setup(): Promise<void> {
  vi.stubGlobal('fetch', gotrueStub);
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true), ($3, $4, 'viewer', true)`,
    [admin, `${admin}@test.local`, inviter, `${inviter}@test.local`]);
  for (const [i, company] of companies.entries()) {
    await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [company, `delinv co ${i}`]);
    await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [company, inviter]);
  }
}

export async function teardown(): Promise<void> {
  vi.unstubAllGlobals();
  try {
    await pool.query('DELETE FROM company_invitations WHERE company_id = ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[]) OR user_id = ANY($2)', [companies, created]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [created]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, inviter]]);
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1)', [[
      'admin:127.0.0.79', ...digests.map((d) => `invite-accept:${d}`), ...ips.map((ip) => `invite-accept-by-ip:ip:${ip}`)]]);
  } finally {
    await Promise.all([pool.end(), migrationAdminPool().end()]);
  }
}

/** Clears the admin route's per-IP limiter between tests (every admin call here comes from one address). */
export const resetAdminLimit = () => pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");

const n = async (text: string, params: unknown[]) => (await pool.query(text, params)).rows[0].n as number;
export const usersRows = (id: string) => n('SELECT count(*)::int n FROM users WHERE id = $1', [id]);
export const memberships = (id: string) => n('SELECT count(*)::int n FROM company_users WHERE lower(user_id) = lower($1)', [id]);
/** Invitations to this address (any case, any spacing) not yet accepted. */
export const pendingFor = (email: string) => n(
  'SELECT count(*)::int n FROM company_invitations WHERE lower(btrim(email)) = lower(btrim($1)) AND accepted_at IS NULL', [email]);
export const invitationRow = async (raw: string) => (await pool.query(
  'SELECT accepted_at FROM company_invitations WHERE token = $1', [hashInviteToken(raw)])).rows[0] as { accepted_at: Date | null } | undefined;
export async function deleteAudit(userId: string): Promise<Array<Record<string, unknown>>> {
  return (await pool.query(`SELECT details FROM admin_audit_log WHERE target_id = $1 AND action = 'user.delete'`, [userId]))
    .rows.map((r) => r.details as Record<string, unknown>);
}

/**
 * Calls `after(sqlText)` once each statement a migration_admin client runs has returned (the accept routes' pool),
 * for the race barrier. Both connect() shapes: pg.Pool.query checks out with the callback form.
 */
export function onMigrationAdminStatement(after: (text: string) => Promise<void>): void {
  const target = migrationAdminPool();
  const realConnect = target.connect.bind(target) as (...a: unknown[]) => unknown;
  const wrap = (client: pg.PoolClient | undefined): pg.PoolClient | undefined => {
    if (!client || (client as unknown as { delinv?: true }).delinv) return client;
    (client as unknown as { delinv?: true }).delinv = true;
    const realQuery = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
    (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      const result = await realQuery(...args);
      if (typeof args[0] === 'string') await after(args[0]);
      return result;
    };
    return client;
  };
  (target as unknown as { connect: unknown }).connect = (...args: unknown[]) => {
    if (typeof args[0] === 'function') {
      const cb = args[0] as (e: unknown, c: pg.PoolClient | undefined, d: unknown) => void;
      return realConnect((e: unknown, c: pg.PoolClient | undefined, d: unknown) => cb(e, wrap(c), d));
    }
    return (realConnect() as Promise<pg.PoolClient>).then(wrap);
  };
}
