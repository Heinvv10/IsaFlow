/**
 * #1656: a user the admin portal adds to a company gets a live membership at once, the same one
 * an accepted app invitation gives (a company_users row withAuth admits), never a pending
 * invitation. And the admin portal shows and edits the app's roles and per-module permissions:
 * it grants manager, refuses the retired bookkeeper, and a permission it sets is the one the
 * app enforces.
 *
 * Through the real routes (withAdmin / withPlatformAdmin on platform_admin, migrations 883/1010's
 * guard, the audit write) and withAuth's own membership read (getCompanyMembership).
 * Disposable schema fixture only (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import addRoute from '../../pages/api/admin/users/[id]/add-to-company';
import permissionsRoute from '../../pages/api/admin/users/[id]/permissions';
import { getCompanyMembership } from '@/lib/auth/companyMembership';
import { isActiveUserAccount } from '@/lib/auth/userAccountStatus';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const admin = crypto.randomUUID();
const member = crypto.randomUUID();
const company = crypto.randomUUID();
let seededModule = false;

type Route = (req: never, res: never) => Promise<unknown>;
async function call(route: Route, method: string, path: string, query: Record<string, string>, body?: unknown) {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, method, member) as unknown as { body: unknown; url: string; query: Record<string, string> };
  req.body = body;
  req.query = { id: member, ...query };
  req.url = `/api/admin/users/${member}/${path}`;
  const result = response();
  await route(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as { data?: Record<string, unknown>; error?: { message?: string } } };
}
const add = (role: string) => call(addRoute as Route, 'POST', 'add-to-company', {}, { company_id: company, role });

beforeAll(async () => {
  // Migration 270 seeds permission_modules; the schema-only CI baseline holds no rows.
  seededModule = (await pool.query(`INSERT INTO permission_modules (module_key, module_name, display_order)
    VALUES ('suppliers', 'Suppliers & AP', 30) ON CONFLICT (module_key) DO NOTHING RETURNING id`)).rowCount === 1;
  await pool.query(`INSERT INTO companies (id, name, created_at) VALUES ($1, $2, NOW())`, [company, `R1656 ${company}`]);
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [member, `${member}@test.local`]);
}, 60000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM company_user_permissions WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, member]]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
    if (seededModule) await pool.query("DELETE FROM permission_modules WHERE module_key = 'suppliers'");
    await pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'admin:%'");
  } finally {
    await pool.end();
  }
}, 60000);

describe('admin add-to-company gives a live membership, not a pending invitation (#1656)', () => {
  it('refuses the retired portal role bookkeeper (400) and writes nothing', async () => {
    const r = await add('bookkeeper');
    expect(r.status).toBe(400);
    expect((await pool.query('SELECT 1 FROM company_users WHERE company_id = $1', [company])).rowCount).toBe(0);
  }, 30000);

  it('adds the user as a manager: withAuth admits them at once, and no invitation is left pending', async () => {
    const r = await add('manager');
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const client = await pool.connect();
    try {
      const membership = await getCompanyMembership(client, member, company);
      expect(membership.rows).toHaveLength(1);
      expect(membership.rows[0]!.role).toBe('manager');
      expect(isActiveUserAccount(membership.rows[0]!)).toBe(true);
    } finally {
      client.release();
    }
    const pending = await pool.query(
      'SELECT 1 FROM company_invitations WHERE company_id = $1 AND accepted_at IS NULL', [company]);
    expect(pending.rowCount).toBe(0);
  }, 30000);

  it("shows the app's permission model: a manager approves by default; unticking Approve on Suppliers & AP is stored for the app to enforce", async () => {
    const before = await call(permissionsRoute as Route, 'GET', 'permissions', { company_id: company });
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.data?.role).toBe('manager');
    const suppliers = (before.body.data?.permissions as Array<{ moduleKey: string; canApprove: boolean; canDelete: boolean }>)
      .find((p) => p.moduleKey === 'suppliers');
    expect(suppliers).toMatchObject({ canApprove: true, canDelete: false });

    const set = await call(permissionsRoute as Route, 'POST', 'permissions', { company_id: company }, {
      company_id: company, moduleKey: 'suppliers',
      canRead: true, canWrite: true, canDelete: false, canExport: true, canApprove: false,
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const row = await pool.query(
      `SELECT can_approve, can_write FROM company_user_permissions WHERE company_id = $1 AND user_id = $2 AND module_key = 'suppliers'`,
      [company, member]);
    expect(row.rows).toEqual([{ can_approve: false, can_write: true }]);
    const audited = await pool.query(
      `SELECT details FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'user.set_module_permission' AND target_id = $2`,
      [admin, member]);
    expect(audited.rows[0]?.details).toMatchObject({ company_id: company, module_key: 'suppliers', canApprove: false });
  }, 30000);

  it('a user not linked to the company is a 404 on the permissions route', async () => {
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [company]);
    const r = await call(permissionsRoute as Route, 'GET', 'permissions', { company_id: company });
    expect(r.status).toBe(404);
  }, 30000);
});
