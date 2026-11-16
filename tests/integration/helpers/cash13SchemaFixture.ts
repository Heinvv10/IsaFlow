/**
 * Shared by the migration 999i schema suites: two synthetic companies (each with an owner and a revenue
 * account), the insert statements, and a transaction as withAuth opens one (app_user, claims, company).
 */
import type { Pool, PoolClient } from 'pg';

export type Co = { id: string; user: string; account: string };

export const ITEM = `INSERT INTO cash_forecast_items (company_id, direction, amount, expected_date, repeat, repeat_until, description, gl_account_id)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_by, created_at, updated_by, updated_at`;
export const item = (co: string, o: Partial<{ direction: string; amount: number; date: string; repeat: string; until: string | null; desc: string; account: string | null }> = {}) =>
  [co, o.direction ?? 'receipt', o.amount ?? 1000, o.date ?? '2026-12-01', o.repeat ?? 'none', o.until ?? null, o.desc ?? 'Deposit', o.account ?? null];
export const OVR = `INSERT INTO cash_forecast_overrides (company_id, line_key, week_start, mode, amount, target_week_start, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_by, updated_by`;
// 2026-11-16 and 2026-11-23 are Mondays; 2026-11-17 is a Tuesday.
export const ovr = (co: string, o: Partial<{ key: string; week: string; mode: string; amount: number; target: string | null; note: string | null }> = {}) =>
  [co, o.key ?? 'payroll:net', o.week ?? '2026-11-16', o.mode ?? 'set', o.amount ?? 0, o.target ?? null, o.note ?? null];

export function cash13SchemaFixture(pool: Pool) {
  const mk = (): Co => ({ id: crypto.randomUUID(), user: crypto.randomUUID(), account: '' });
  const A = mk(), B = mk();

  async function setUp(): Promise<void> {
    for (const c of [A, B]) {
      await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [c.id, `Cash13 ${c.id.slice(0, 8)}`]);
      await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [c.user, `${c.user}@test.local`]);
      await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')", [c.id, c.user]);
      c.account = String((await pool.query(
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
         VALUES ($1, 'CF-4000', 'Sales', 'revenue', 'credit', 3, true) RETURNING id`, [c.id])).rows[0].id);
    }
  }

  async function tearDown(): Promise<void> {
    for (const t of ['cash_forecast_items', 'cash_forecast_overrides', 'payroll_company_settings', 'gl_accounts', 'company_users']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [[A.id, B.id]]);
    }
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[A.user, B.user]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[A.id, B.id]]);
  }

  /** A transaction as withAuth opens one for `c`'s member in company `co` (default: c's own). Rolled back unless `commit`. */
  async function as<T>(c: { id: string; user: string }, fn: (q: PoolClient) => Promise<T>, commit = false, co = c.id): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: c.user })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [co]);
      const out = await fn(client);
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  }

  return { A, B, setUp, tearDown, as };
}

/** The SQLSTATE (and constraint) a statement fails with, or 'ok'. */
export async function codeOf(q: PoolClient, text: string, params: unknown[] = []): Promise<string> {
  await q.query('SAVEPOINT p');
  try {
    await q.query(text, params);
    await q.query('RELEASE SAVEPOINT p');
    return 'ok';
  } catch (err) {
    await q.query('ROLLBACK TO SAVEPOINT p');
    const e = err as { code?: string; constraint?: string };
    return e.constraint ? `${e.code}:${e.constraint}` : String(e.code);
  }
}
