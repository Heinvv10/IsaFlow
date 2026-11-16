/**
 * Migration 999g as app_user: cash_forecast_items and cash_forecast_overrides are tenant-isolated
 * under forced RLS (944's predicate); stamps are the trigger's (a forged value is overwritten, an
 * UPDATE keeps the creation stamps, no session user is refused); the CHECKs hold (amount, direction,
 * repeat, description, Monday weeks, mode/amount, move_to target); an item's account is its company's;
 * one override per (company, line, week); and the file is safe to run twice. Also the salary pay-day
 * columns on payroll_company_settings. Real PostgreSQL; synthetic rows only.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const mk = () => ({ id: crypto.randomUUID(), user: crypto.randomUUID(), account: '' });
const A = mk(), B = mk();
let itemB = '', overrideB = '';

const ITEM = `INSERT INTO cash_forecast_items (company_id, direction, amount, expected_date, repeat, repeat_until, description, gl_account_id)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_by, created_at, updated_by, updated_at`;
const item = (co: string, o: Partial<{ direction: string; amount: number; date: string; repeat: string; until: string | null; desc: string; account: string | null }> = {}) =>
  [co, o.direction ?? 'receipt', o.amount ?? 1000, o.date ?? '2026-12-01', o.repeat ?? 'none', o.until ?? null, o.desc ?? 'Deposit', o.account ?? null];
const OVR = `INSERT INTO cash_forecast_overrides (company_id, line_key, week_start, mode, amount, target_week_start, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_by, updated_by`;
// 2026-11-16 and 2026-11-23 are Mondays; 2026-11-17 is a Tuesday.
const ovr = (co: string, o: Partial<{ key: string; week: string; mode: string; amount: number; target: string | null; note: string | null }> = {}) =>
  [co, o.key ?? 'payroll:net', o.week ?? '2026-11-16', o.mode ?? 'set', o.amount ?? 0, o.target ?? null, o.note ?? null];

beforeAll(async () => {
  for (const c of [A, B]) {
    await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [c.id, `Cash13 ${c.id.slice(0, 8)}`]);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [c.user, `${c.user}@test.local`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')", [c.id, c.user]);
    c.account = String((await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       VALUES ($1, 'CF-4000', 'Sales', 'revenue', 'credit', 3, true) RETURNING id`, [c.id])).rows[0].id);
  }
  await as(B, async (q) => {
    itemB = String((await q.query(ITEM, item(B.id))).rows[0].id);
    overrideB = String((await q.query(OVR, ovr(B.id))).rows[0].id);
  }, true);
}, 60_000);
afterAll(async () => {
  try {
    for (const t of ['cash_forecast_items', 'cash_forecast_overrides', 'payroll_company_settings', 'gl_accounts', 'company_users']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [[A.id, B.id]]);
    }
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[A.user, B.user]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[A.id, B.id]]);
  } finally { await pool.end(); }
});

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

/** The SQLSTATE (and constraint) a statement fails with, or 'ok'. */
async function codeOf(q: PoolClient, text: string, params: unknown[] = []): Promise<string> {
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

describe('999g: tenancy', () => {
  it.each(['cash_forecast_items', 'cash_forecast_overrides'])('%s: RLS enabled and forced, the 944 predicate both ways', async (t) => {
    const r = (await pool.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity, pg_get_expr(p.polqual, p.polrelid) q, pg_get_expr(p.polwithcheck, p.polrelid) w
         FROM pg_class c JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
        WHERE c.oid = $1::regclass`, [t])).rows[0];
    expect(r.relrowsecurity).toBe(true);
    expect(r.relforcerowsecurity).toBe(true);
    for (const e of [r.q, r.w]) {
      expect(e).toContain('app.current_company_id()');
      expect(e).toContain('auth.user_companies()');
    }
  });

  it("A reads, updates and deletes none of B's rows", async () => {
    await as(A, async (q) => {
      for (const [t, id] of [['cash_forecast_items', itemB], ['cash_forecast_overrides', overrideB]] as const) {
        expect((await q.query(`SELECT COUNT(*)::int n FROM ${t} WHERE id = $1`, [id])).rows[0].n).toBe(0);
        expect((await q.query(`UPDATE ${t} SET amount = 5 WHERE id = $1`, [id])).rowCount).toBe(0);
        expect((await q.query(`DELETE FROM ${t} WHERE id = $1`, [id])).rowCount).toBe(0);
      }
    });
    expect((await pool.query('SELECT amount::float a FROM cash_forecast_items WHERE id = $1', [itemB])).rows[0].a).toBe(1000);
  });

  it("A cannot write into B's company", async () => {
    await as(A, async (q) => {
      expect(await codeOf(q, ITEM, item(B.id))).toBe('42501');
      expect(await codeOf(q, OVR, ovr(B.id))).toBe('42501');
    });
  });

  it("A's member with B active (not a member of B) reads nothing of B", async () => {
    await as(A, async (q) => {
      expect((await q.query('SELECT COUNT(*)::int n FROM cash_forecast_items WHERE company_id = $1', [B.id])).rows[0].n).toBe(0);
      expect((await q.query('SELECT COUNT(*)::int n FROM cash_forecast_overrides WHERE company_id = $1', [B.id])).rows[0].n).toBe(0);
    }, false, B.id);
  });

  it("B's own session reads its rows", async () => {
    await as(B, async (q) => {
      expect((await q.query('SELECT COUNT(*)::int n FROM cash_forecast_items WHERE id = $1', [itemB])).rows[0].n).toBe(1);
      expect((await q.query('SELECT COUNT(*)::int n FROM cash_forecast_overrides WHERE id = $1', [overrideB])).rows[0].n).toBe(1);
    });
  });
});

describe('999g: stamps and privileges', () => {
  it.each([
    ['cash_forecast_items', 'created_by'], ['cash_forecast_items', 'updated_at'], ['cash_forecast_items', 'id'],
    ['cash_forecast_overrides', 'created_by'], ['cash_forecast_overrides', 'updated_by'], ['cash_forecast_overrides', 'id'],
  ])('%s.%s cannot be sent by app_user', async (t, col) => {
    const v = col === 'id' ? crypto.randomUUID() : col.endsWith('_at') ? '2020-01-01' : 'forged';
    const sqlText = t === 'cash_forecast_items'
      ? `INSERT INTO cash_forecast_items (company_id, direction, amount, expected_date, description, ${col}) VALUES ($1, 'receipt', 1, '2026-12-01', 'x', $2)`
      : `INSERT INTO cash_forecast_overrides (company_id, line_key, week_start, mode, amount, ${col}) VALUES ($1, 'k', '2026-11-16', 'set', 1, $2)`;
    await as(A, async (q) => { expect(await codeOf(q, sqlText, [A.id, v])).toBe('42501'); });
  });

  it('app_user cannot UPDATE company_id or a stamp', async () => {
    await as(B, async (q) => {
      for (const t of ['cash_forecast_items', 'cash_forecast_overrides']) {
        expect(await codeOf(q, `UPDATE ${t} SET company_id = $1`, [A.id])).toBe('42501');
        expect(await codeOf(q, `UPDATE ${t} SET created_by = 'x'`)).toBe('42501');
        expect(await codeOf(q, `UPDATE ${t} SET updated_at = now()`)).toBe('42501');
      }
    });
  });

  it('the trigger stamps the session user and the clock on insert', async () => {
    await as(A, async (q) => {
      for (const r of [(await q.query(ITEM, item(A.id))).rows[0], (await q.query(OVR, ovr(A.id))).rows[0]]) {
        expect(r.created_by).toBe(A.user);
        expect(r.updated_by).toBe(A.user);
      }
    });
  });

  it('a privileged writer forging stamps is overwritten; an UPDATE keeps the creation stamps and restamps updated_*', async () => {
    await as(A, async (q) => {
      await q.query('RESET ROLE');
      const r = (await q.query(
        `INSERT INTO cash_forecast_items (company_id, direction, amount, expected_date, description, created_by, created_at, updated_by, updated_at)
         VALUES ($1, 'payment', 5, '2026-12-01', 'x', 'forged', '2020-01-01', 'forged', '2020-01-01') RETURNING id, created_by, created_at, updated_by`, [A.id])).rows[0];
      expect(r.created_by).toBe(A.user);
      expect(r.updated_by).toBe(A.user);
      expect(new Date(r.created_at).getUTCFullYear()).toBeGreaterThan(2020);
      await q.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: B.user })]);
      const u = (await q.query(
        `UPDATE cash_forecast_items SET amount = 6, created_by = 'forged', created_at = '2020-01-01', updated_by = 'forged' WHERE id = $1
         RETURNING created_by, created_at, updated_by`, [r.id])).rows[0];
      expect(u.created_by).toBe(A.user);
      expect(new Date(u.created_at).toISOString()).toBe(new Date(r.created_at).toISOString());
      expect(u.updated_by).toBe(B.user);
    });
  });

  it("no role moves a row to another company", async () => {
    await as(A, async (q) => {
      await q.query('RESET ROLE');
      const id = String((await q.query(ITEM, item(A.id))).rows[0].id);
      expect(await codeOf(q, 'UPDATE cash_forecast_items SET company_id = $1 WHERE id = $2', [B.id, id])).toBe('42501');
    });
  });

  it('a write with no session user is refused', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      expect(await codeOf(c, ITEM, item(A.id))).toBe('42501');
      expect(await codeOf(c, OVR, ovr(A.id))).toBe('42501');
      expect(await codeOf(c, 'UPDATE cash_forecast_items SET amount = 7 WHERE id = $1', [itemB])).toBe('42501');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  it('app_user may update the editable columns and delete', async () => {
    await as(B, async (q) => {
      expect(await codeOf(q, `UPDATE cash_forecast_items SET direction = 'payment', amount = 9, expected_date = '2026-12-02', repeat = 'weekly',
                              repeat_until = '2027-01-01', description = 'y', gl_account_id = $2 WHERE id = $1`, [itemB, B.account])).toBe('ok');
      expect(await codeOf(q, "UPDATE cash_forecast_overrides SET mode = 'add', amount = -3, note = 'n' WHERE id = $1", [overrideB])).toBe('ok');
      expect((await q.query('DELETE FROM cash_forecast_items WHERE id = $1', [itemB])).rowCount).toBe(1);
      expect((await q.query('DELETE FROM cash_forecast_overrides WHERE id = $1', [overrideB])).rowCount).toBe(1);
    });
  });
});

describe('999g: item rules', () => {
  const cases: Array<[string, Parameters<typeof item>[1], string]> = [
    ['amount 0', { amount: 0 }, '23514:cash_forecast_items_amount_check'],
    ['negative amount', { amount: -1 }, '23514:cash_forecast_items_amount_check'],
    ['unknown direction', { direction: 'transfer' }, '23514:cash_forecast_items_direction_check'],
    ['unknown repeat', { repeat: 'daily' }, '23514:cash_forecast_items_repeat_check'],
    ['repeat_until on a one-off', { repeat: 'none', until: '2027-01-01' }, '23514:cash_forecast_items_repeat_until_check'],
    ['repeat_until before the date', { repeat: 'monthly', until: '2026-11-30' }, '23514:cash_forecast_items_repeat_until_check'],
    ['blank description', { desc: '   ' }, '23514:cash_forecast_items_description_check'],
    ['description of 201', { desc: 'x'.repeat(201) }, '23514:cash_forecast_items_description_check'],
  ];
  it.each(cases)('%s is refused', async (_n, o, code) => {
    await as(A, async (q) => { expect(await codeOf(q, ITEM, item(A.id, o))).toBe(code); });
  });

  it('the boundaries pass: 0.01, 200 characters, repeat_until on the date, open-ended monthly', async () => {
    await as(A, async (q) => {
      expect(await codeOf(q, ITEM, item(A.id, { amount: 0.01 }))).toBe('ok');
      expect(await codeOf(q, ITEM, item(A.id, { desc: 'x'.repeat(200) }))).toBe('ok');
      expect(await codeOf(q, ITEM, item(A.id, { repeat: 'weekly', until: '2026-12-01' }))).toBe('ok');
      expect(await codeOf(q, ITEM, item(A.id, { repeat: 'monthly', until: null }))).toBe('ok');
    });
  });

  it("an item's account must be its company's (insert and update)", async () => {
    await as(A, async (q) => {
      expect(await codeOf(q, ITEM, item(A.id, { account: B.account }))).toBe('23514:cash_forecast_items_account_company');
      const id = String((await q.query(ITEM, item(A.id, { account: A.account }))).rows[0].id);
      expect(await codeOf(q, 'UPDATE cash_forecast_items SET gl_account_id = $1 WHERE id = $2', [B.account, id])).toBe('23514:cash_forecast_items_account_company');
    });
  });

  it('an account a forecast item names is not deleted (23503)', async () => {
    await as(A, async (q) => {
      await q.query(ITEM, item(A.id, { account: A.account }));
      await q.query('RESET ROLE');
      expect(await codeOf(q, 'DELETE FROM gl_accounts WHERE id = $1', [A.account])).toMatch(/^23503/);
    });
  });
});

describe('999g: override rules', () => {
  const cases: Array<[string, Parameters<typeof ovr>[1], string]> = [
    ['a Tuesday week', { week: '2026-11-17' }, '23514:cash_forecast_overrides_week_monday'],
    ['set below 0', { mode: 'set', amount: -1 }, '23514:cash_forecast_overrides_mode_amount'],
    ['add of 0', { mode: 'add', amount: 0 }, '23514:cash_forecast_overrides_mode_amount'],
    ['move_to of 0', { mode: 'move_to', amount: 0, target: '2026-11-23' }, '23514:cash_forecast_overrides_mode_amount'],
    ['move_to negative', { mode: 'move_to', amount: -5, target: '2026-11-23' }, '23514:cash_forecast_overrides_mode_amount'],
    ['unknown mode', { mode: 'scale', amount: 1 }, '23514:cash_forecast_overrides_mode_amount'],
    ['move_to without target', { mode: 'move_to', amount: 5, target: null }, '23514:cash_forecast_overrides_target'],
    ['move_to to a Tuesday', { mode: 'move_to', amount: 5, target: '2026-11-24' }, '23514:cash_forecast_overrides_target'],
    ['move_to to its own week', { mode: 'move_to', amount: 5, target: '2026-11-16' }, '23514:cash_forecast_overrides_target'],
    ['set with a target', { mode: 'set', amount: 5, target: '2026-11-23' }, '23514:cash_forecast_overrides_target'],
    ['add with a target', { mode: 'add', amount: 5, target: '2026-11-23' }, '23514:cash_forecast_overrides_target'],
    ['blank line key', { key: ' ' }, '23514:cash_forecast_overrides_line_key_check'],
    ['line key of 201', { key: 'k'.repeat(201) }, '23514:cash_forecast_overrides_line_key_check'],
    ['note of 501', { note: 'n'.repeat(501) }, '23514:cash_forecast_overrides_note_check'],
  ];
  it.each(cases)('%s is refused', async (_n, o, code) => {
    await as(A, async (q) => { expect(await codeOf(q, OVR, ovr(A.id, o))).toBe(code); });
  });

  it('valid shapes pass: set 0, add negative, move_to a later or earlier Monday', async () => {
    await as(A, async (q) => {
      expect(await codeOf(q, OVR, ovr(A.id, { key: 'a', mode: 'set', amount: 0 }))).toBe('ok');
      expect(await codeOf(q, OVR, ovr(A.id, { key: 'b', mode: 'add', amount: -250.5 }))).toBe('ok');
      expect(await codeOf(q, OVR, ovr(A.id, { key: 'c', mode: 'move_to', amount: 100, target: '2026-11-23' }))).toBe('ok');
      expect(await codeOf(q, OVR, ovr(A.id, { key: 'd', week: '2026-11-23', mode: 'move_to', amount: 100, target: '2026-11-16' }))).toBe('ok');
    });
  });

  it('one override per (company, line, week): a second is 23505; another week or company is its own', async () => {
    await as(A, async (q) => {
      expect(await codeOf(q, OVR, ovr(A.id, { key: 'dup' }))).toBe('ok');
      expect(await codeOf(q, OVR, ovr(A.id, { key: 'dup', mode: 'add', amount: 1 }))).toBe('23505:uq_cash_forecast_overrides_line_week');
      expect(await codeOf(q, OVR, ovr(A.id, { key: 'dup', week: '2026-11-23' }))).toBe('ok');
    });
  });
});

describe('999g: salary pay day', () => {
  it('defaults to day 25 of the month; app_user may write both columns', async () => {
    await as(A, async (q) => {
      const r = (await q.query(
        'INSERT INTO payroll_company_settings (company_id, updated_by) VALUES ($1, $2) RETURNING salary_pay_rule, salary_pay_day', [A.id, A.user])).rows[0];
      expect(r).toEqual({ salary_pay_rule: 'day_of_month', salary_pay_day: 25 });
      expect(await codeOf(q, "UPDATE payroll_company_settings SET salary_pay_rule = 'last_working_day', salary_pay_day = 31 WHERE company_id = $1", [A.id])).toBe('ok');
    });
  });

  it.each([[0], [32]])('day %i is refused', async (d) => {
    await as(A, async (q) => {
      expect(await codeOf(q, 'INSERT INTO payroll_company_settings (company_id, salary_pay_day) VALUES ($1, $2)', [A.id, d]))
        .toBe('23514:payroll_company_settings_salary_pay_day_check');
    });
  });

  it('an unknown rule is refused', async () => {
    await as(A, async (q) => {
      expect(await codeOf(q, "INSERT INTO payroll_company_settings (company_id, salary_pay_rule) VALUES ($1, 'first_friday')", [A.id]))
        .toBe('23514:payroll_company_settings_salary_pay_rule_check');
    });
  });
});

describe('999g: re-run', () => {
  it('the file applies a second time over existing rows and leaves the rules in place', async () => {
    const file = readFileSync(join(process.cwd(), 'scripts/migrations/sql/999g_cash_forecast_13.sql'), 'utf8');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(file);
      await c.query('COMMIT');
    } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
    await as(A, async (q) => {
      expect(await codeOf(q, OVR, ovr(A.id, { week: '2026-11-17' }))).toBe('23514:cash_forecast_overrides_week_monday');
      expect(await codeOf(q, ITEM, item(A.id, { amount: 0 }))).toBe('23514:cash_forecast_items_amount_check');
      expect(await codeOf(q, `INSERT INTO cash_forecast_items (company_id, direction, amount, expected_date, description, created_by)
                              VALUES ($1, 'receipt', 1, '2026-12-01', 'x', 'f')`, [A.id])).toBe('42501');
    });
    const n = (await pool.query(`SELECT COUNT(*)::int n FROM pg_trigger WHERE tgrelid = 'cash_forecast_items'::regclass AND NOT tgisinternal`)).rows[0].n;
    expect(n).toBe(2);
  });
});
