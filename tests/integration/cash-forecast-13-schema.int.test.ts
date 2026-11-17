/**
 * Migration 999i as app_user, tenancy and stamps: cash_forecast_items and cash_forecast_overrides are
 * tenant-isolated under forced RLS (944's predicate); stamps are the trigger's (a forged value is
 * overwritten, an UPDATE keeps the creation stamps, no session user is refused); app_user writes only the
 * granted columns. Rules, pay day and re-run: cash-forecast-13-schema-rules. Real PostgreSQL; synthetic rows.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ITEM, OVR, cash13SchemaFixture, codeOf, item, ovr } from './helpers/cash13SchemaFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, B, setUp, tearDown, as } = cash13SchemaFixture(pool);
let itemB = '', overrideB = '';

beforeAll(async () => {
  await setUp();
  await as(B, async (q) => {
    itemB = String((await q.query(ITEM, item(B.id))).rows[0].id);
    overrideB = String((await q.query(OVR, ovr(B.id))).rows[0].id);
  }, true);
}, 60_000);
afterAll(async () => {
  try { await tearDown(); } finally { await pool.end(); }
});

describe('999i: tenancy', () => {
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

describe('999i: stamps and privileges', () => {
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
        // Same value: the trigger lets it by, so only the column privilege refuses it.
        expect(await codeOf(q, `UPDATE ${t} SET company_id = company_id`)).toBe('42501');
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

