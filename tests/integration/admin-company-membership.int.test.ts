/**
 * Admin portal: remove a company link, and change a linked user's role, through
 * the real routes (withAdmin / withPlatformAdmin on the platform_admin role, the
 * migration 883 trigger, the audit write).
 *
 * The seeded ISAFlow Demo company id (00000000-…-0001, a version-0 UUID) is the
 * case from 2026-10-16: removing its link "did nothing". The prod logs showed no
 * DELETE reached the server (a client-side confirm that timed out); the server
 * also answered 200 for a delete that matched no row. Both are covered: the
 * remove works for the demo id, and an unlinked pair is a 404.
 *
 * Disposable schema fixture only (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import removeRoute from '../../pages/api/admin/users/[id]/remove-from-company';
import roleRoute from '../../pages/api/admin/users/[id]/company-role';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const DEMO = '00000000-0000-0000-0000-000000000001';
const admin = crypto.randomUUID();
const alice = crypto.randomUUID();
const bob = crypto.randomUUID();
const company = crypto.randomUUID();
let createdDemo = false;

type Route = (req: never, res: never) => Promise<unknown>;
async function call(route: Route, method: string, target: string, body: unknown) {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, method, target) as unknown as { body: unknown; url: string };
  req.body = body;
  req.url = `/api/admin/users/${target}`;
  const result = response();
  await route(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as { error?: { message?: string } } };
}
const remove = (user: string, companyId: string) => call(removeRoute as Route, 'DELETE', user, { company_id: companyId });
const setRole = (user: string, companyId: string, role: string) =>
  call(roleRoute as Route, 'PATCH', user, { company_id: companyId, role });

async function link(user: string, companyId: string, role: string) {
  await pool.query(`INSERT INTO company_users (user_id, company_id, role) VALUES ($1, $2, $3)
    ON CONFLICT (user_id, company_id) DO UPDATE SET role = EXCLUDED.role`, [user, companyId, role]);
}
async function roleOf(user: string, companyId: string): Promise<string | null> {
  const r = await pool.query('SELECT role FROM company_users WHERE user_id = $1 AND company_id = $2', [user, companyId]);
  return (r.rows[0]?.role as string | undefined) ?? null;
}
async function audits(action: string, user: string) {
  return (await pool.query(`SELECT details FROM admin_audit_log WHERE admin_user_id = $1 AND action = $2
    AND target_id = $3 ORDER BY created_at`, [admin, action, user])).rows.map(r => r.details as Record<string, unknown>);
}

beforeAll(async () => {
  createdDemo = (await pool.query(`INSERT INTO companies (id, name, created_at) VALUES ($1, 'ISAFlow Demo (fixture)', NOW())
    ON CONFLICT (id) DO NOTHING RETURNING id`, [DEMO])).rowCount === 1;
  await pool.query(`INSERT INTO companies (id, name, created_at) VALUES ($1, $2, NOW())`, [company, `MEMB ${company}`]);
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`,
    [admin, `${admin}@test.local`]);
  for (const u of [alice, bob]) {
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [u, `${u}@test.local`]);
  }
}, 60000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1)', [[alice, bob]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, alice, bob]]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
    if (createdDemo) await pool.query('DELETE FROM companies WHERE id = $1', [DEMO]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally {
    await pool.end();
  }
}, 60000);

describe('admin: remove a company link', () => {
  it('removes the ISAFlow Demo link (version-0 UUID) and audits the previous role', async () => {
    await link(alice, DEMO, 'bookkeeper');
    const r = await remove(alice, DEMO);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await roleOf(alice, DEMO)).toBeNull();
    expect(await audits('user.remove_from_company', alice)).toEqual([{ company_id: DEMO, previous_role: 'bookkeeper' }]);
  }, 30000);

  it('a link that does not exist is a 404, not a silent 200, and nothing is audited', async () => {
    const before = (await audits('user.remove_from_company', bob)).length;
    const r = await remove(bob, DEMO);
    expect(r.status).toBe(404);
    expect(r.body.error?.message).toMatch(/not linked/);
    expect((await audits('user.remove_from_company', bob)).length).toBe(before);
  }, 30000);

  it("refuses removing the company's last owner (409); with a second owner it removes", async () => {
    await link(alice, company, 'owner');
    const refused = await remove(alice, company);
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toMatch(/last owner/);
    expect(await roleOf(alice, company)).toBe('owner');

    await link(bob, company, 'owner');
    const ok = await remove(alice, company);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await roleOf(alice, company)).toBeNull();
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [company]);
  }, 30000);
});

describe('admin: change a linked company role', () => {
  it('changes the role and audits it', async () => {
    await link(alice, company, 'viewer');
    const r = await setRole(alice, company, 'accountant');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await roleOf(alice, company)).toBe('accountant');
    expect(await audits('user.change_company_role', alice))
      .toEqual([{ company_id: company, previous_role: 'viewer', role: 'accountant' }]);
  }, 30000);

  it('refuses a role outside the allowed set, owner included (400), and changes nothing', async () => {
    for (const role of ['superuser', 'owner', 'manager']) {
      const r = await setRole(alice, company, role);
      expect(r.status, role).toBe(400);
    }
    expect(await roleOf(alice, company)).toBe('accountant');
  }, 30000);

  it('an unlinked user is a 404', async () => {
    expect((await setRole(bob, company, 'viewer')).status).toBe(404);
    expect(await roleOf(bob, company)).toBeNull();
  }, 30000);

  it("refuses demoting the company's last owner (409); with a second owner it demotes", async () => {
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [company]);
    await link(alice, company, 'owner');
    const refused = await setRole(alice, company, 'admin');
    expect(refused.status).toBe(409);
    expect(await roleOf(alice, company)).toBe('owner');

    await link(bob, company, 'owner');
    const ok = await setRole(alice, company, 'admin');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await roleOf(alice, company)).toBe('admin');
  }, 30000);
});
