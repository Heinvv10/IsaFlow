/**
 * #1656 (review of #1670): migration 1010's role mapping and 1010b's permission write guard, on the
 * fixture database (both are applied by the integration build; this re-runs 1010's file on seeded
 * legacy rows, as a re-run on production would see them).
 *
 * 1010: accountant / bookkeeper → manager WITHOUT approve (a row per module, can_approve false,
 * recorded in role_values_1656_backup); storeman / technician / user → viewer; pending legacy
 * invitations → viewer; a manager's existing row with can_approve false gets approve once (M1,
 * the marker row), recorded; company_users.role defaults to viewer; a second run changes nothing.
 * 1010b: as app_user, only an owner or admin of the company writes company_user_permissions.
 *
 * Disposable schema fixture only (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const MIGRATION = readFileSync('scripts/migrations/sql/1010_unify_company_roles.sql', 'utf8');
const company = crypto.randomUUID();
const ids = { owner: crypto.randomUUID(), book: crypto.randomUUID(), store: crypto.randomUUID(), mgr: crypto.randomUUID(), acct: crypto.randomUUID() };
const MODULES = [['suppliers', 'Suppliers & AP', 30], ['customers', 'Customers & AR', 20], ['payroll', 'Payroll', 130]] as const;
const seededModules: string[] = [];
let inviteId = '';

async function asApp<T>(sub: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'authenticated', sub, session_id: crypto.randomUUID() })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
const roleOf = async (u: string) =>
  (await pool.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [company, u])).rows[0]?.role as string;
const permsOf = async (u: string) => (await pool.query(
  `SELECT module_key, can_read, can_write, can_delete, can_export, can_approve FROM company_user_permissions
   WHERE company_id = $1 AND user_id = $2 AND module_key = ANY($3) ORDER BY module_key`,
  [company, u, MODULES.map((m) => m[0])])).rows;
const backup = async () => (await pool.query(
  `SELECT source_table, old_role, new_role FROM role_values_1656_backup
   WHERE (row_id LIKE $1 || ':%' AND split_part(row_id, ':', 3) = ANY($3)) OR row_id = ANY($2)
      OR row_id IN (SELECT id::text FROM company_user_permissions WHERE company_id = $1::uuid)
   ORDER BY source_table, row_id`,
  [company, [inviteId, ids.acct], MODULES.map((m) => m[0])])).rows;

beforeAll(async () => {
  for (const [key, name, order] of MODULES) {
    const r = await pool.query(`INSERT INTO permission_modules (module_key, module_name, display_order) VALUES ($1, $2, $3)
      ON CONFLICT (module_key) DO NOTHING RETURNING module_key`, [key, name, order]);
    if (r.rowCount === 1) seededModules.push(key);
  }
  await pool.query('INSERT INTO companies (id, name, created_at) VALUES ($1, $2, NOW())', [company, `R1656 mig ${company}`]);
  for (const [k, id] of Object.entries(ids)) {
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, $3, true)`,
      [id, `${id}@test.local`, k === 'acct' ? 'accountant' : 'viewer']);
  }
  // Legacy values, written as the table owner (as before #1656, when the guards allowed them).
  await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES
    ($1, $2, 'owner'), ($1, $3, 'bookkeeper'), ($1, $4, 'storeman'), ($1, $5, 'manager')`,
    [company, ids.owner, ids.book, ids.store, ids.mgr]);
  // A manager row saved from the old all-off grid (M1), and a legacy member's own earlier row.
  await pool.query(`INSERT INTO company_user_permissions (company_id, user_id, module_key, can_read, can_write, can_approve)
    VALUES ($1, $2, 'suppliers', true, true, false), ($1, $3, 'customers', true, false, true)`, [company, ids.mgr, ids.book]);
  inviteId = (await pool.query(`INSERT INTO company_invitations (company_id, email, role, token, invited_by, expires_at)
    VALUES ($1, $2, 'technician', $3, $4, NOW() + interval '7 days') RETURNING id`,
    [company, `${company}@invitee.test`, `tok-${company}`, ids.owner])).rows[0].id as string;
  // M1 runs once per database (its marker); let this run see the seeded manager row.
  await pool.query("DELETE FROM role_values_1656_backup WHERE source_table = 'marker' AND row_id = 'manager_approve_backfill'");
  await pool.query(MIGRATION);
}, 120000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_invitations WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM company_user_permissions WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [Object.values(ids)]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
    if (seededModules.length) await pool.query('DELETE FROM permission_modules WHERE module_key = ANY($1)', [seededModules]);
  } finally {
    await pool.end();
  }
}, 60000);

describe('migration 1010: the legacy mapping', () => {
  it('bookkeeper → manager with a row per module: manager defaults, never approve (its own row loses approve), nothing on Payroll', async () => {
    expect(await roleOf(ids.book)).toBe('manager');
    expect(await permsOf(ids.book)).toEqual([
      { module_key: 'customers', can_read: true, can_write: false, can_delete: false, can_export: false, can_approve: false },
      { module_key: 'payroll', can_read: false, can_write: false, can_delete: false, can_export: false, can_approve: false },
      { module_key: 'suppliers', can_read: true, can_write: true, can_delete: false, can_export: true, can_approve: false },
    ]);
  });

  it("adds the 'budgets' permission module", async () => {
    expect((await pool.query("SELECT module_name FROM permission_modules WHERE module_key = 'budgets'")).rows).toEqual([{ module_name: 'Budgets' }]);
  });

  it('storeman → viewer; owner untouched; the pending technician invitation → viewer; users.role accountant → manager', async () => {
    expect(await roleOf(ids.store)).toBe('viewer');
    expect(await roleOf(ids.owner)).toBe('owner');
    expect((await pool.query('SELECT role FROM company_invitations WHERE id = $1', [inviteId])).rows[0].role).toBe('viewer');
    expect((await pool.query('SELECT role FROM users WHERE id = $1', [ids.acct])).rows[0].role).toBe('manager');
  });

  it("M1: a manager's existing row with can_approve false gets approve, recorded", async () => {
    expect(await permsOf(ids.mgr)).toEqual([
      { module_key: 'suppliers', can_read: true, can_write: true, can_delete: false, can_export: false, can_approve: true }]);
    const recorded = await backup();
    expect(recorded).toContainEqual({ source_table: 'company_user_permissions', old_role: 'can_approve=false', new_role: 'can_approve=true' });
  });

  it('records every change: the memberships, the legacy permission rows (old value or none), the invitation and the users row', async () => {
    const recorded = await backup();
    const legacy = recorded.filter((r) => r.source_table === 'company_user_permissions_legacy');
    // The old row as JSON (restorable, the 1010 header's rollback), or 'no row' (the rollback deletes it).
    expect(legacy.map((r) => r.old_role).sort()).toEqual([
      'no row', 'no row', '{"can_read" : true, "can_write" : false, "can_delete" : false, "can_export" : false, "can_approve" : true}']);
    expect(legacy.map((r) => r.new_role).sort()).toEqual(['can_approve=false', 'can_approve=false', 'no access']);
    expect(recorded.filter((r) => r.source_table === 'company_invitations')).toEqual(
      [{ source_table: 'company_invitations', old_role: 'technician', new_role: 'viewer' }]);
    expect(recorded.filter((r) => r.source_table === 'users')).toEqual(
      [{ source_table: 'users', old_role: 'accountant', new_role: 'manager' }]);
  });

  it('a second run changes nothing and records nothing new', async () => {
    const before = { book: await permsOf(ids.book), mgr: await permsOf(ids.mgr), backup: await backup() };
    await pool.query(MIGRATION);
    expect({ book: await permsOf(ids.book), mgr: await permsOf(ids.mgr), backup: await backup() }).toEqual(before);
  });

  it("company_users.role's default is viewer", async () => {
    const u = crypto.randomUUID();
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [u, `${u}@test.local`]);
    try {
      await pool.query('INSERT INTO company_users (company_id, user_id) VALUES ($1, $2)', [company, u]);
      expect(await roleOf(u)).toBe('viewer');
    } finally {
      await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [company, u]);
      await pool.query('DELETE FROM users WHERE id = $1', [u]);
    }
  });
});

describe('migration 1010b: only an owner or admin writes module permissions (as app_user)', () => {
  const tick = (c: PoolClient) => c.query(`UPDATE company_user_permissions SET can_approve = true
    WHERE company_id = $1 AND user_id = $2 AND module_key = 'suppliers'`, [company, ids.book]);

  it('the manager whose approve was taken cannot tick it back, insert a row or delete one (42501)', async () => {
    expect(await outcome(asApp(ids.book, tick))).toBe('42501');
    expect(await outcome(asApp(ids.book, (c) => c.query(`INSERT INTO company_user_permissions (company_id, user_id, module_key, can_approve)
      VALUES ($1, $2, 'banking', true)`, [company, ids.book])))).toBe('42501');
    expect(await outcome(asApp(ids.book, (c) => c.query(
      'DELETE FROM company_user_permissions WHERE company_id = $1 AND user_id = $2', [company, ids.book])))).toBe('42501');
  });

  it('the owner can', async () => {
    expect(await outcome(asApp(ids.owner, tick))).toBe('ok');
  });
});
