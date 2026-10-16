/** Edge cases for admin company membership (edge-case repros, review of PR A). Disposable fixture only. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import removeRoute from '../../pages/api/admin/users/[id]/remove-from-company';
import roleRoute from '../../pages/api/admin/users/[id]/company-role';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const admin = crypto.randomUUID();
const company = crypto.randomUUID();
const hex = () => crypto.randomUUID();
const users: string[] = [];

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
const remove = (u: string, c: unknown) => call(removeRoute as Route, 'DELETE', u, { company_id: c });
const setRole = (u: string, c: string, role: unknown) => call(roleRoute as Route, 'PATCH', u, { company_id: c, role });
async function link(user: string, role: string, companyId = company) {
  await pool.query(`INSERT INTO company_users (user_id, company_id, role) VALUES ($1,$2,$3)`, [user, companyId, role]);
}
async function roles(): Promise<Record<string, string>> {
  const r = await pool.query('SELECT user_id, role FROM company_users WHERE company_id = $1', [company]);
  return Object.fromEntries(r.rows.map(x => [x.user_id, x.role]));
}
async function auditCount(action: string) {
  return (await pool.query('SELECT count(*)::int n FROM admin_audit_log WHERE admin_user_id=$1 AND action=$2', [admin, action])).rows[0].n as number;
}
async function reset() { await pool.query('DELETE FROM company_users WHERE company_id = $1', [company]); }
async function mkUser(id: string) {
  users.push(id);
  await pool.query(`INSERT INTO users (id,email,role,is_active) VALUES ($1,$2,'viewer',true) ON CONFLICT DO NOTHING`, [id, `${id}@test.local`]);
}

beforeAll(async () => {
  await pool.query(`INSERT INTO companies (id,name,created_at) VALUES ($1,$2,NOW())`, [company, `EDGE ${company}`]);
  await pool.query(`INSERT INTO users (id,email,role,is_active) VALUES ($1,$2,'super_admin',true)`, [admin, `${admin}@test.local`]);
}, 60000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, ...users]]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally { await pool.end(); }
}, 60000);

describe('case handling of user_id', () => {
  it('URL id in a different case than stored user_id still finds the link (remove)', async () => {
    await reset();
    const u = hex(); await mkUser(u.toUpperCase()); await mkUser(hex());
    await link(u.toUpperCase(), 'viewer');
    const r = await remove(u.toLowerCase(), company);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }, 30000);

  it('URL id in different case finds the link (role change)', async () => {
    await reset();
    const u = hex(); await link(u.toUpperCase(), 'viewer');
    const r = await setRole(u.toLowerCase(), company, 'admin');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }, 30000);

  it('same person as only two owner rows (two cases): removing one is refused 409', async () => {
    await reset();
    const u = hex(); await link(u.toLowerCase(), 'owner'); await link(u.toUpperCase(), 'owner');
    const r = await remove(u.toLowerCase(), company);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(Object.keys(await roles()).length).toBe(2);
  }, 30000);

  it('same person as only two owner rows: demoting one is refused 409', async () => {
    await reset();
    const u = hex(); await link(u.toLowerCase(), 'owner'); await link(u.toUpperCase(), 'owner');
    const r = await setRole(u.toLowerCase(), company, 'viewer');
    expect(r.status, JSON.stringify(r.body)).toBe(409);
  }, 30000);
});

describe('role edge cases', () => {
  it('demoting to the same role is a 200 no-op without an audit row', async () => {
    await reset(); const u = hex(); await link(u, 'viewer');
    const before = await auditCount('user.change_company_role');
    const r = await setRole(u, company, 'viewer');
    expect(r.status).toBe(200);
    expect(await auditCount('user.change_company_role')).toBe(before);
  }, 30000);

  it('owner "set to owner" is refused 400 (owner not grantable), even for sole owner', async () => {
    await reset(); const u = hex(); await link(u, 'owner');
    expect((await setRole(u, company, 'owner')).status).toBe(400);
  }, 30000);

  it('whitespace / uppercase / non-string role is 400 and changes nothing', async () => {
    await reset(); const u = hex(); await link(u, 'viewer');
    for (const role of [' admin', 'admin ', 'ADMIN', 'Admin', '', 'a'.repeat(51), 5, null, ['admin'], {}, undefined]) {
      const r = await setRole(u, company, role);
      expect(r.status, JSON.stringify(role)).toBe(400);
    }
    expect((await roles())[u]).toBe('viewer');
  }, 60000);

  it("a row stored as 'Owner' (odd case) is the last owner: removal refused", async () => {
    await reset(); const u = hex();
    try { await link(u, 'Owner'); } catch { return; } // CHECK/trigger refuses odd case: nothing to test
    const r = await remove(u, company);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
  }, 30000);
});

describe('body validation', () => {
  it('garbage company_id / body shapes are 400 on both routes and mutate nothing', async () => {
    await reset(); const u = hex(); await link(u, 'viewer');
    for (const c of ['not-a-guid', '', 123, null, undefined, {}, [company], `${company}'; DROP TABLE x;--`]) {
      expect((await remove(u, c)).status, `remove ${JSON.stringify(c)}`).toBe(400);
      expect((await setRole(u, c as string, 'admin')).status, `role ${JSON.stringify(c)}`).toBe(400);
    }
    for (const body of [null, undefined, 'x', 7, [], [{ company_id: company }]]) {
      expect((await call(removeRoute as Route, 'DELETE', u, body)).status, `body ${JSON.stringify(body)}`).toBe(400);
      expect((await call(roleRoute as Route, 'PATCH', u, body)).status, `pbody ${JSON.stringify(body)}`).toBe(400);
    }
    expect((await roles())[u]).toBe('viewer');
  }, 60000);

  it('extra keys are refused (strict) and nothing is changed', async () => {
    await reset(); const u = hex(); await link(u, 'viewer');
    const a = await call(removeRoute as Route, 'DELETE', u, { company_id: company, force: true });
    const b = await call(roleRoute as Route, 'PATCH', u, { company_id: company, role: 'admin', user_id: 'x' });
    expect(a.status).toBe(400); expect(b.status).toBe(400);
    expect((await roles())[u]).toBe('viewer');
  }, 30000);

  it('wrong methods are 405 and mutate nothing', async () => {
    await reset(); const u = hex(); await link(u, 'viewer');
    for (const m of ['GET', 'PATCH', 'PUT', 'POST']) {
      expect((await call(removeRoute as Route, m, u, { company_id: company })).status, `remove ${m}`).toBe(405);
    }
    for (const m of ['GET', 'DELETE', 'PUT', 'POST']) {
      expect((await call(roleRoute as Route, m, u, { company_id: company, role: 'admin' })).status, `role ${m}`).toBe(405);
    }
    expect((await roles())[u]).toBe('viewer');
  }, 60000);

  it('non-existent company with valid guid is 404, not 500', async () => {
    const r = await remove(hex(), crypto.randomUUID());
    expect(r.status).toBe(404);
  }, 30000);
});

describe('concurrency', () => {
  it('two owners demoted simultaneously: exactly one succeeds, one owner remains', async () => {
    for (let i = 0; i < 5; i++) {
      await reset(); const a = hex(), b = hex(); await link(a, 'owner'); await link(b, 'owner');
      const rs = await Promise.all([setRole(a, company, 'admin'), setRole(b, company, 'admin')]);
      const st = rs.map(r => r.status).sort();
      expect(st, `iter ${i}`).toEqual([200, 409]);
      expect(Object.values(await roles()).filter(x => x === 'owner').length).toBe(1);
    }
  }, 120000);

  it('two owners removed simultaneously: exactly one succeeds', async () => {
    for (let i = 0; i < 5; i++) {
      await reset(); const a = hex(), b = hex(); await link(a, 'owner'); await link(b, 'owner');
      const rs = await Promise.all([remove(a, company), remove(b, company)]);
      expect(rs.map(r => r.status).sort(), `iter ${i}`).toEqual([200, 409]);
      expect(Object.keys(await roles()).length).toBe(1);
    }
  }, 120000);

  it('one owner demoted while the other is removed: exactly one succeeds', async () => {
    for (let i = 0; i < 5; i++) {
      await reset(); const a = hex(), b = hex(); await link(a, 'owner'); await link(b, 'owner');
      const rs = await Promise.all([setRole(a, company, 'admin'), remove(b, company)]);
      expect(rs.map(r => r.status).sort(), `iter ${i}`).toEqual([200, 409]);
      expect(Object.values(await roles()).filter(x => x === 'owner').length).toBe(1);
    }
  }, 120000);
});
