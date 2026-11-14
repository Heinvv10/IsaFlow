/**
 * Migration 990 must give migration_admin what the sign-in stamp writes. The baseline fixture (a dump of dev) has
 * migration_admin holding ALL on users, which would hide a production cluster where it holds SELECT only
 * (migrations 930/932/945 list SELECT; 982 had to grant UPDATE (account_type) the same way). So this suite strips
 * migration_admin to SELECT inside a transaction, applies 990's own file, and runs the stamp as migration_admin.
 * Everything is rolled back. Disposable schema fixture only (assertDisposable).
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { SIGN_IN_STAMP_SQL, SIGN_IN_THROTTLE_MINUTES } from '@/lib/auth/recordSignIn';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const MIGRATION = readFileSync('scripts/migrations/sql/990_users_login_count.sql', 'utf8');
const user = crypto.randomUUID();

afterAll(async () => { await pool.end(); });

/** Production's migration_admin: SELECT on users, nothing else. Runs `body` in a transaction that is rolled back. */
async function asProduction<T>(body: (q: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('REVOKE ALL ON public.users FROM migration_admin');
    await client.query('GRANT SELECT ON public.users TO migration_admin');
    await client.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [user, `${user}@wp3-grant.test`]);
    return await body((text, params) => client.query(text, params as unknown[]));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('migration 990 and migration_admin', () => {
  it('without it, a SELECT-only migration_admin cannot stamp (the premise)', async () => {
    const error = await asProduction(async (q) => {
      await q('SET LOCAL ROLE migration_admin');
      return q(SIGN_IN_STAMP_SQL, [user, SIGN_IN_THROTTLE_MINUTES]).then(() => null, (e: Error) => e.message);
    });
    expect(error).toMatch(/permission denied for table users/);
  });

  it('applying 990 grants UPDATE on last_login and login_count only, and the stamp then works as migration_admin', async () => {
    const out = await asProduction(async (q) => {
      await q(MIGRATION);
      const priv = async (col: string) => (await q(
        `SELECT has_column_privilege('migration_admin', 'public.users', $1, 'UPDATE') AS ok`, [col])).rows[0]!.ok;
      const granted = { last_login: await priv('last_login'), login_count: await priv('login_count'), email: await priv('email'), role: await priv('role') };
      await q('SET LOCAL ROLE migration_admin');
      const stamped = await q(SIGN_IN_STAMP_SQL, [user, SIGN_IN_THROTTLE_MINUTES]);
      await q('RESET ROLE');
      const row = (await q('SELECT last_login, login_count FROM users WHERE id = $1', [user])).rows[0]!;
      return { granted, rowCount: stamped.rowCount, count: row.login_count, last: row.last_login };
    });
    expect(out.granted).toEqual({ last_login: true, login_count: true, email: false, role: false });
    expect(out.rowCount).toBe(1);
    expect(out.count).toBe(1);
    expect(out.last).toBeInstanceOf(Date);
  });

  it('grants no app role anything on these columns', async () => {
    const out = await asProduction(async (q) => {
      await q(MIGRATION);
      const rows = (await q(
        `SELECT r.rolname, c.col, has_column_privilege(r.rolname, 'public.users', c.col, 'UPDATE') AS can
           FROM pg_roles r, (VALUES ('last_login'), ('login_count')) c(col)
          WHERE r.rolname IN ('app_user', 'app_service', 'isaflow_app', 'isaflow_service')`)).rows;
      return rows.filter((r) => r.can);
    });
    expect(out).toEqual([]);
  });
});
