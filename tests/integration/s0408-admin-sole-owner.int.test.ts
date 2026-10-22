/**
 * Audit S-04/S-08 follow-up A, through the real admin routes (withAdmin /
 * withPlatformAdmin on platform_admin, migration 908b's trigger, the audit write):
 *
 * - DELETE /api/admin/users/[id] and POST …/reset-onboarding remove a user from
 *   every company. When the user is the only owner of any of them, both are a
 *   409 naming those companies, and nothing is written: no membership, session
 *   or user row goes, and no audit row is added.
 * - The trigger's own refusal (RC011) reaches the admin site as the same 409:
 *   a co-owner row stored as 'Owner ' passes the service's count (btrim/lower)
 *   but not the trigger's (exact 'owner', as 886 counts).
 *
 * The admin pool runs as platform_admin (not the fixture's superuser).
 * Disposable schema fixture only (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import userRoute from '../../pages/api/admin/users/[id]';
import resetRoute from '../../pages/api/admin/users/[id]/reset-onboarding';
import removeRoute from '../../pages/api/admin/users/[id]/remove-from-company';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
// The admin routes' pool logs in as platform_admin, as on production. The
// fixture's URL logs in as a superuser, which 908b exempts, so the session's
// role is set at connect (the pools are created on first use, after this).
const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const admin = crypto.randomUUID();
const users: string[] = [];
const companies: string[] = [];
const ONLY_OWNER = "This user is the company's only owner. Make someone else owner first.";

type Route = (req: never, res: never) => Promise<unknown>;
async function call(route: Route, method: string, target: string, path: string, body: unknown) {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, method, target) as unknown as { body: unknown; url: string };
  req.body = body;
  req.url = `/api/admin/users/${target}${path}`;
  const result = response();
  await route(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as { error?: { message?: string } } };
}
const deleteUser = (u: string) => call(userRoute as Route, 'DELETE', u, '', undefined);
const resetOnboarding = (u: string) => call(resetRoute as Route, 'POST', u, '/reset-onboarding', undefined);
const removeLink = (u: string, c: string) => call(removeRoute as Route, 'DELETE', u, '/remove-from-company', { company_id: c });

async function user(): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed) VALUES ($1, $2, 'viewer', true, true)`,
    [id, `${id}@test.local`]);
  await pool.query(`INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
    [id, `s0408-${id}`]);
  users.push(id);
  return id;
}
async function company(name: string, members: [string, string][]): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [id, `${name} ${id.slice(0, 6)}`]);
  companies.push(id);
  for (const [u, role] of members) {
    await pool.query('INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)', [id, u, role]);
  }
  return id;
}
const nameOf = async (c: string) => (await pool.query('SELECT name FROM companies WHERE id = $1', [c])).rows[0].name as string;
const state = async (u: string) => (await pool.query(`SELECT
    (SELECT count(*)::int FROM company_users WHERE user_id = $1) AS links,
    (SELECT count(*)::int FROM user_sessions WHERE user_id = $1) AS sessions,
    (SELECT onboarding_completed FROM users WHERE id = $1) AS onboarded,
    (SELECT count(*)::int FROM admin_audit_log WHERE admin_user_id = $2 AND target_id = $1) AS audits`, [u, admin])).rows[0];

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
}, 60000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM user_sessions WHERE user_id = ANY($1)', [users]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, ...users]]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally {
    await pool.end();
  }
}, 60000);

describe("admin: a company's only owner is not deleted or reset", () => {
  it.each([
    ['delete user', deleteUser],
    ['reset onboarding', resetOnboarding],
  ] as const)('%s: 409 naming each company they own alone; nothing written', async (_, act) => {
    const [u, other] = [await user(), await user()];
    const soleA = await company('Sole A', [[u, 'owner'], [other, 'admin']]);
    const soleB = await company('Sole B', [[u, 'owner']]);
    await company('Shared', [[u, 'owner'], [other, 'owner']]);
    await company('Member', [[other, 'owner'], [u, 'viewer']]);
    const before = await state(u);

    const r = await act(u);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    const names = [await nameOf(soleA), await nameOf(soleB)].sort();
    expect(r.body.error?.message).toBe(`This user is the only owner of ${names.join(', ')}. Make someone else owner first.`);
    expect(await state(u)).toEqual(before);
    expect(before).toMatchObject({ links: 4, sessions: 1, onboarded: true });
  }, 30000);

  it('with another owner everywhere, delete user goes through', async () => {
    const [u, other] = [await user(), await user()];
    await company('Shared', [[u, 'owner'], [other, 'owner']]);
    const r = await deleteUser(u);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await state(u)).toMatchObject({ links: 0, sessions: 0, onboarded: null });
  }, 30000);

  it('with another owner everywhere, reset onboarding goes through', async () => {
    const [u, other] = [await user(), await user()];
    await company('Shared', [[u, 'owner'], [other, 'owner']]);
    const r = await resetOnboarding(u);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await state(u)).toMatchObject({ links: 0, sessions: 0, onboarded: false });
  }, 30000);
});

describe("admin: the trigger's last-owner refusal (RC011) is the same 409", () => {
  it("remove-from-company: a co-owner stored as 'Owner ' satisfies the service, not the trigger", async () => {
    const [u, other] = [await user(), await user()];
    const c = await company('Odd', [[u, 'owner'], [other, 'Owner ']]);
    const r = await removeLink(u, c);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error?.message).toBe(ONLY_OWNER);
    expect((await pool.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [c, u])).rows[0].role).toBe('owner');
  }, 30000);

  it('the pool really is platform_admin', async () => {
    const probe = new Pool({ connectionString: process.env.PLATFORM_ADMIN_DATABASE_URL, max: 1 });
    try {
      expect((await probe.query('SELECT current_user AS u')).rows[0].u).toBe('platform_admin');
    } finally {
      await probe.end();
    }
  });

  it('the admin site\'s own last-owner refusal uses the same words', async () => {
    const u = await user();
    const c = await company('Alone', [[u, 'owner']]);
    const r = await removeLink(u, c);
    expect(r.status).toBe(409);
    expect(r.body.error?.message).toBe(ONLY_OWNER);
  }, 30000);
});
