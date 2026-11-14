/**
 * Audit 2026-11-14 items 1.1 and 2.7: nothing wrote users.last_login, so the admin console's activity figures were
 * permanently empty, and a company's "Last Active" was companies.updated_at (when its row was last edited).
 *
 * Real PostgreSQL, the sign-in recorder on the migration_admin login (the role production runs it as; the
 * app roles have no write on this column), and the admin readers on the pool role.
 * Disposable schema fixture only (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const sfx = crypto.randomUUID().slice(0, 8);
const [alice, bob, carol, ghost] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const [coActive, coNever, coMixed] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

async function stamp(user: string): Promise<{ last: Date | null; count: number }> {
  const r = await pool.query('SELECT last_login, login_count FROM users WHERE id = $1', [user]);
  return { last: (r.rows[0]?.last_login as Date | null) ?? null, count: Number(r.rows[0]?.login_count) };
}

beforeAll(async () => {
  // As production: the recorder's pool logs in as migration_admin. `postgres` here is a superuser, so the role is
  // forced on the session; a missing grant on users would fail these tests.
  vi.stubEnv('MIGRATION_ADMIN_DATABASE_URL', `${process.env.DATABASE_URL}?options=-c%20role%3Dmigration_admin`);
  for (const u of [alice, bob, carol]) {
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [u, `${u}@wp3-${sfx}.test`]);
  }
  for (const [id, name] of [[coActive, 'Active'], [coNever, 'Never'], [coMixed, 'Mixed']] as const) {
    await pool.query(`INSERT INTO companies (id, name, created_at, updated_at) VALUES ($1, $2, NOW(), NOW())`, [id, `WP3 ${name} ${sfx}`]);
  }
  const link = (c: string, u: string) => pool.query(`INSERT INTO company_users (user_id, company_id, role) VALUES ($1, $2, 'viewer')`, [u, c]);
  await link(coActive, alice);
  await link(coNever, carol);
  await link(coMixed, alice);
  await link(coMixed, bob);
}, 60000);

afterAll(async () => {
  try {
    const users = [alice, bob, carol];
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1)', [users]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [users]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[coActive, coNever, coMixed]]);
  } finally {
    await pool.end();
    vi.unstubAllEnvs();
  }
});

describe('recordSignIn', () => {
  it('first sign-in stamps last_login and counts one', async () => {
    const { recordSignIn } = await import('@/lib/auth/recordSignIn');
    expect(await stamp(alice)).toEqual({ last: null, count: 0 });
    expect(await recordSignIn(alice)).toBe(true);
    const after = await stamp(alice);
    expect(after.count).toBe(1);
    expect(Date.now() - after.last!.getTime()).toBeLessThan(60_000);
  });

  it('is throttled: a second sign-in within the window writes nothing', async () => {
    const { recordSignIn } = await import('@/lib/auth/recordSignIn');
    const before = await stamp(alice);
    expect(await recordSignIn(alice)).toBe(false);
    expect(await stamp(alice)).toEqual(before);
  });

  it('a sign-in after the window stamps again and counts two', async () => {
    const { recordSignIn } = await import('@/lib/auth/recordSignIn');
    await pool.query(`UPDATE users SET last_login = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [alice]);
    const before = await stamp(alice);
    expect(await recordSignIn(alice)).toBe(true);
    const after = await stamp(alice);
    expect(after.count).toBe(2);
    expect(after.last!.getTime()).toBeGreaterThan(before.last!.getTime());
  });

  it('runs as migration_admin, the role production runs it as', async () => {
    const { migrationAdminPool } = await import('@/lib/auth/migrationAdminPool');
    expect((await migrationAdminPool().query('SELECT current_user AS who')).rows[0]?.who).toBe('migration_admin');
  });

  it('never waits on a row another transaction holds: skipped, uncounted', async () => {
    const { recordSignIn } = await import('@/lib/auth/recordSignIn');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [bob]);
      const before = await stamp(bob);
      const t0 = Date.now();
      expect(await recordSignIn(bob)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(await stamp(bob)).toEqual(before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('a user with no profile row records nothing and does not throw', async () => {
    const { recordSignIn } = await import('@/lib/auth/recordSignIn');
    expect(await recordSignIn(ghost)).toBe(false);
  });
});

describe('company Last Active is the latest member sign-in', () => {
  const sees = async (id: string) => {
    const { getCompanyDetail, listCompanies } = await import('@/modules/admin/services/adminCompanyService');
    const detail = await getCompanyDetail(id);
    const list = await listCompanies({ search: `${sfx}`, limit: 50 });
    const row = list.items.find((c) => c.id === id);
    return { detail: detail?.last_active ?? null, list: row?.last_active ?? null };
  };

  it('is the member last_login, not companies.updated_at', async () => {
    const aliceLast = (await stamp(alice)).last!.toISOString();
    const seen = await sees(coActive);
    expect(seen.detail).toBe(aliceLast);
    expect(seen.list).toBe(aliceLast);
  });

  it('is the most recent across several members', async () => {
    await pool.query(`UPDATE users SET last_login = '2026-05-01T08:00:00Z' WHERE id = $1`, [bob]);
    const aliceLast = (await stamp(alice)).last!.toISOString();
    const seen = await sees(coMixed);
    expect(seen.detail).toBe(aliceLast);
    expect(seen.list).toBe(aliceLast);
  });

  it('is null when no member ever signed in, however recently the row was edited', async () => {
    await pool.query(`UPDATE companies SET updated_at = NOW() WHERE id = $1`, [coNever]);
    const seen = await sees(coNever);
    expect(seen.detail).toBeNull();
    expect(seen.list).toBeNull();
  });
});

describe('admin user readers', () => {
  it('Login Count is the recorded sign-in count and Last Login the stamp', async () => {
    const { getUserDetail, listUsers } = await import('@/modules/admin/services/adminUserService');
    const detail = await getUserDetail(alice);
    expect(detail?.login_count).toBe(2);
    expect(detail?.last_login).toBe((await stamp(alice)).last!.toISOString());
    const list = await listUsers({ search: `wp3-${sfx}`, limit: 50 });
    expect(list.items.find((u) => u.id === alice)?.login_count).toBe(2);
    expect(list.items.find((u) => u.id === carol)?.login_count).toBe(0);
    expect(list.items.find((u) => u.id === carol)?.last_login).toBeNull();
  });
});
