/**
 * Migration 999i as app_user, the rules: item CHECKs (amount, direction, repeat, description) and its
 * company-matched account; override CHECKs (Monday weeks, mode/amount, move_to target) and one override per
 * (company, line, week); the salary pay-day columns; and the file is safe to run twice. Real PostgreSQL.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ITEM, OVR, cash13SchemaFixture, codeOf, item, ovr } from './helpers/cash13SchemaFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, B, setUp, tearDown, as } = cash13SchemaFixture(pool);

beforeAll(async () => { await setUp(); }, 60_000);
afterAll(async () => {
  try { await tearDown(); } finally { await pool.end(); }
});

describe('999i: item rules', () => {
  const cases: Array<[string, Parameters<typeof item>[1], string]> = [
    ['amount 0', { amount: 0 }, '23514:cash_forecast_items_amount_check'],
    ['negative amount', { amount: -1 }, '23514:cash_forecast_items_amount_check'],
    ['unknown direction', { direction: 'transfer' }, '23514:cash_forecast_items_direction_check'],
    ['unknown repeat', { repeat: 'daily' }, '23514:cash_forecast_items_repeat_check'],
    ['repeat_until on a one-off', { repeat: 'none', until: '2027-01-01' }, '23514:cash_forecast_items_repeat_until_check'],
    ['repeat_until before the date', { repeat: 'monthly', until: '2026-11-30' }, '23514:cash_forecast_items_repeat_until_check'],
    ['blank description', { desc: '   ' }, '23514:cash_forecast_items_description_check'],
    ['description of 201', { desc: 'x'.repeat(201) }, '23514:cash_forecast_items_description_check'],
    ['a date before 2000', { date: '1999-12-31' }, '23514:cash_forecast_items_dates_in_range'],
    ['a date after 2100', { date: '2101-01-01' }, '23514:cash_forecast_items_dates_in_range'],
    ['a repeat end after 2100', { repeat: 'weekly', until: '2101-01-01' }, '23514:cash_forecast_items_dates_in_range'],
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
      expect(await codeOf(q, ITEM, item(A.id, { date: '2000-01-01', repeat: 'weekly', until: '2100-12-31' }))).toBe('ok');
    });
  });

  it('category is one of the engine list, default other', async () => {
    await as(A, async (q) => {
      const id = String((await q.query(ITEM, item(A.id))).rows[0].id);
      expect((await q.query('SELECT category FROM cash_forecast_items WHERE id = $1', [id])).rows[0].category).toBe('other');
      expect(await codeOf(q, "UPDATE cash_forecast_items SET category = 'loans' WHERE id = $1", [id])).toBe('ok');
      expect(await codeOf(q, "UPDATE cash_forecast_items SET category = 'tax' WHERE id = $1", [id])).toBe('23514:cash_forecast_items_category_check');
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

describe('999i: override rules', () => {
  const cases: Array<[string, Parameters<typeof ovr>[1], string]> = [
    ['a Tuesday week', { week: '2026-11-17' }, '23514:cash_forecast_overrides_week_monday'],
    ['set with no amount', { mode: 'set', amount: null }, '23514:cash_forecast_overrides_mode_amount'],
    ['add with no amount', { mode: 'add', amount: null }, '23514:cash_forecast_overrides_mode_amount'],
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
    ['a week before 2000', { week: '1999-12-27' }, '23514:cash_forecast_overrides_dates_in_range'],
    ['a week after 2100', { week: '2101-01-03' }, '23514:cash_forecast_overrides_dates_in_range'],
    ['a target after 2100', { week: '2100-12-27', mode: 'move_to', amount: 1, target: '2101-01-03' }, '23514:cash_forecast_overrides_dates_in_range'],
  ];
  it.each(cases)('%s is refused', async (_n, o, code) => {
    await as(A, async (q) => { expect(await codeOf(q, OVR, ovr(A.id, o))).toBe(code); });
  });

  it('valid shapes pass: set 0 or negative, add negative, move_to whole cell, a later or earlier Monday', async () => {
    await as(A, async (q) => {
      expect(await codeOf(q, OVR, ovr(A.id, { key: 'a', mode: 'set', amount: 0 }))).toBe('ok');
      expect(await codeOf(q, OVR, ovr(A.id, { key: 'b', mode: 'add', amount: -250.5 }))).toBe('ok');
      expect(await codeOf(q, OVR, ovr(A.id, { key: 'b2', mode: 'set', amount: -80000 }))).toBe('ok');
      expect(await codeOf(q, OVR, ovr(A.id, { key: 'b3', mode: 'move_to', amount: null, target: '2026-11-23' }))).toBe('ok');
      expect(await codeOf(q, OVR, ovr(A.id, { key: 'b4', week: '2000-01-03', mode: 'move_to', amount: 1, target: '2100-12-27' }))).toBe('ok');
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

describe('999i: override applied_at (application order)', () => {
  const at = async (q: import('pg').PoolClient, id: string) =>
    String((await q.query('SELECT applied_at::text AS t FROM cash_forecast_overrides WHERE id = $1', [id])).rows[0].t);

  it('app_user cannot send applied_at', async () => {
    await as(A, async (q) => {
      expect(await codeOf(q, `INSERT INTO cash_forecast_overrides (company_id, line_key, week_start, mode, amount, applied_at)
                              VALUES ($1, 'k', '2026-11-16', 'set', 1, '2020-01-01')`, [A.id])).toBe('42501');
      const id = String((await q.query(OVR, ovr(A.id))).rows[0].id);
      expect(await codeOf(q, "UPDATE cash_forecast_overrides SET applied_at = '2020-01-01' WHERE id = $1", [id])).toBe('42501');
    });
  });

  it('a privileged writer forging applied_at is overwritten on insert and on a figure change', async () => {
    await as(A, async (q) => {
      await q.query('RESET ROLE');
      const r = (await q.query(`INSERT INTO cash_forecast_overrides (company_id, line_key, week_start, mode, amount, applied_at)
                                VALUES ($1, 'k', '2026-11-16', 'set', 1, '2020-01-01') RETURNING id, applied_at`, [A.id])).rows[0];
      expect(new Date(r.applied_at).getUTCFullYear()).toBeGreaterThan(2020);
      const u = (await q.query("UPDATE cash_forecast_overrides SET amount = 2, applied_at = '2020-01-01' WHERE id = $1 RETURNING applied_at", [r.id])).rows[0];
      expect(new Date(u.applied_at).getUTCFullYear()).toBeGreaterThan(2020);
      const n = (await q.query("UPDATE cash_forecast_overrides SET note = 'n', applied_at = '2020-01-01' WHERE id = $1 RETURNING applied_at", [r.id])).rows[0];
      expect(new Date(n.applied_at).toISOString()).toBe(new Date(u.applied_at).toISOString());
    });
  });

  it.each([
    ['mode and amount', "mode = 'add', amount = 5", true],
    ['amount', 'amount = 7', true],
    ['target', "mode = 'move_to', amount = NULL, target_week_start = '2026-11-23'", true],
    ['note only', "note = 'why'", false],
    ['nothing (same values)', 'amount = amount', false],
  ])('an UPDATE of %s restamps applied_at: %s', async (_n, set, restamps) => {
    await as(A, async (q) => {
      const id = String((await q.query(OVR, ovr(A.id, { amount: 3 }))).rows[0].id);
      const before = await at(q, id);
      await q.query(`UPDATE cash_forecast_overrides SET ${set} WHERE id = $1`, [id]);
      expect((await at(q, id)) !== before).toBe(restamps);
    });
  });
  it('an UPDATE of the target week alone restamps applied_at', async () => {
    await as(A, async (q) => {
      const id = String((await q.query(OVR, ovr(A.id, { mode: 'move_to', amount: 5, target: '2026-11-23' }))).rows[0].id);
      const before = await at(q, id);
      await q.query("UPDATE cash_forecast_overrides SET target_week_start = '2026-11-30' WHERE id = $1", [id]);
      expect(await at(q, id)).not.toBe(before);
    });
  });
});

describe('999i: re-run', () => {
  it('the file applies a second time over existing rows and leaves the rules in place', async () => {
    const file = readFileSync(join(process.cwd(), 'scripts/migrations/sql/999i_cash_forecast_13.sql'), 'utf8');
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

  it('over an earlier draft shape (no applied_at / category, pay day NOT NULL DEFAULT 25, amount NOT NULL) it restores this one', async () => {
    const file = readFileSync(join(process.cwd(), 'scripts/migrations/sql/999i_cash_forecast_13.sql'), 'utf8');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM cash_forecast_overrides; DELETE FROM cash_forecast_items; DELETE FROM payroll_company_settings');
      await c.query(`ALTER TABLE cash_forecast_overrides DROP COLUMN applied_at, ALTER COLUMN amount SET NOT NULL;
                     ALTER TABLE cash_forecast_items DROP COLUMN category;
                     ALTER TABLE payroll_company_settings ALTER COLUMN salary_pay_day SET DEFAULT 25, ALTER COLUMN salary_pay_day SET NOT NULL,
                       ALTER COLUMN salary_pay_rule SET DEFAULT 'day_of_month', ALTER COLUMN salary_pay_rule SET NOT NULL`);
      await c.query(file);
      const cols = (await c.query(
        `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
          WHERE (table_name, column_name) IN (('cash_forecast_overrides', 'applied_at'), ('cash_forecast_overrides', 'amount'),
                ('cash_forecast_items', 'category'), ('payroll_company_settings', 'salary_pay_day'), ('payroll_company_settings', 'salary_pay_rule'))
          ORDER BY 1, 2`)).rows;
      expect(cols.map((r) => [r.table_name, r.column_name, r.is_nullable, r.column_default === null])).toEqual([
        ['cash_forecast_items', 'category', 'NO', false],
        ['cash_forecast_overrides', 'amount', 'YES', true],
        ['cash_forecast_overrides', 'applied_at', 'NO', false],
        ['payroll_company_settings', 'salary_pay_day', 'YES', true],
        ['payroll_company_settings', 'salary_pay_rule', 'YES', true],
      ]);
      // The trigger that reads applied_at works on the restored column.
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: A.user })]);
      expect((await c.query(`${OVR.replace('RETURNING id', 'RETURNING applied_at, id')}`, ovr(A.id))).rows[0].applied_at).toBeTruthy();
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
