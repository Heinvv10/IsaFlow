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
});
