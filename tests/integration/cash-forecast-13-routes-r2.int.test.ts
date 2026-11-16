/**
 * Review round 2 of /api/accounting/cash-forecast-13/*, as real members through withAuth's request transaction:
 *   - an item's account must be active and a leaf (a header is 400);
 *   - deleting an item deletes its 'manual:<id>' overrides in the same transaction, each audited;
 *   - a save with nothing changed writes no row change and no audit row (items, overrides, pay day);
 *   - overrides apply in last-edit order (updated_at, id), and the adapter keeps that order;
 *   - a payroll settings row with no pay day chosen (999a's columns only) reads as the default.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import itemsRoute from '../../pages/api/accounting/cash-forecast-13/items';
import overridesRoute from '../../pages/api/accounting/cash-forecast-13/overrides';
import payDayRoute from '../../pages/api/accounting/cash-forecast-13/pay-day';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { clearRateLimitCache } from '@/lib/rateLimit';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { horizonStart, toEngineOverrides } from '@/modules/accounting/services/cashForecast13/engineAdapter';
import type { StoredOverride } from '@/modules/accounting/services/cashForecast13/overridesRepo';
import { addDaysISO } from '@/lib/dateUtils';
import { appToday } from '@/modules/accounting/services/reports/dueByDateService';

/** This week's Monday + k weeks (relative, so the suite never ages into the past). */
const wk = (k: number, d = 0) => addDaysISO(horizonStart(appToday()), 7 * k + d);
assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const items = budgetsRouteFixture(pool, itemsRoute, '/api/accounting/cash-forecast-13/items');
const overrides = budgetsRouteFixture(pool, overridesRoute, '/api/accounting/cash-forecast-13/overrides');
const payDay = budgetsRouteFixture(pool, payDayRoute, '/api/accounting/cash-forecast-13/pay-day');

let a: SetupUser, leaf = '', header = '', inactive = '';
const ITEM = { direction: 'payment', amount: 100, date: wk(2, 1), description: 'Insurance' };
const TODAY = appToday();
const monday = (k: number) => {
  const d = new Date(`${horizonStart(TODAY)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * k);
  return d.toISOString().slice(0, 10);
};

/** Rows written as `a`'s member (the stamp triggers need a session user), committed. */
async function seedAs(text: string, params: unknown[]): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a.userId })]);
    await c.query(text, params);
    await c.query('COMMIT');
  } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
}
const co = () => a.homeCompanyId;
const audit = async (entityType: string) => (await pool.query(
  'SELECT action, entity_id::text AS entity_id FROM audit_log WHERE company_id = $1 AND entity_type = $2 ORDER BY created_at, id', [co(), entityType])).rows;
const clear = async () => {
  for (const t of ['cash_forecast_items', 'cash_forecast_overrides', 'payroll_company_settings', 'audit_log']) {
    await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [co()]);
  }
};

beforeAll(async () => {
  const o = await items.owner();
  a = o.u; leaf = o.account;
  const acct = async (code: string, active: boolean, parent: string | null) => String((await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active, parent_account_id)
     VALUES ($1, $2, $2, 'expense', 'debit', 3, $3, $4) RETURNING id`, [co(), code, active, parent])).rows[0].id);
  header = await acct('CF-H', true, null);
  await acct('CF-H1', true, header);
  inactive = await acct('CF-OFF', false, null);
}, 60_000);
afterAll(async () => {
  try {
    await clear();
    await pool.query('UPDATE gl_accounts SET parent_account_id = NULL WHERE company_id = $1', [co()]);
    await pool.query("DELETE FROM gl_accounts WHERE company_id = $1 AND account_code LIKE 'CF-%'", [co()]);
    await items.cleanup();
  } finally { await pool.end(); }
});

describe('item accounts', () => {
  it('a header or inactive account is 400 on create and on update; a leaf passes', async () => {
    expect((await items.call(a, 'POST', { ...ITEM, accountId: header })).status).toBe(400);
    expect((await items.call(a, 'POST', { ...ITEM, accountId: inactive })).status).toBe(400);
    const ok = await items.call(a, 'POST', { ...ITEM, accountId: leaf });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const id = String(ok.body.data!.id);
    expect((await items.call(a, 'PUT', { ...ITEM, id, accountId: header })).status).toBe(400);
    expect((await items.call(a, 'PUT', { ...ITEM, id, accountId: inactive })).status).toBe(400);
    await clear();
  });
});

describe('deleting an item', () => {
  it("deletes its 'manual:<id>' overrides in the same transaction, each audited; others stay", async () => {
    const id = String((await items.call(a, 'POST', ITEM)).body.data!.id);
    for (const [lineKey, weekStart] of [[`manual:${id}`, monday(1)], [`manual:${id}`, monday(2)], ['payroll:net', monday(1)]]) {
      expect((await overrides.call(a, 'PUT', { lineKey, weekStart, mode: 'set', amount: -1 })).status).toBe(200);
    }
    expect((await items.call(a, 'DELETE', undefined, { id })).status).toBe(200);
    const left = (await pool.query('SELECT line_key FROM cash_forecast_overrides WHERE company_id = $1', [co()])).rows;
    expect(left).toEqual([{ line_key: 'payroll:net' }]);
    expect((await audit('cash_forecast_override')).map((r) => r.action)).toEqual(['create', 'create', 'create', 'delete', 'delete']);
    expect((await audit('cash_forecast_item')).map((r) => r.action)).toEqual(['create', 'delete']);
    await clear();
  });
});

describe('a save with nothing changed', () => {
  const stamp = async (t: string) => (await pool.query(`SELECT updated_at FROM ${t} WHERE company_id = $1`, [co()])).rows[0].updated_at;

  it('item: 200 with the row, no UPDATE, no audit row', async () => {
    const body = { ...ITEM, accountId: leaf, repeat: 'monthly', repeatUntil: wk(14), category: 'loans' };
    const created = await items.call(a, 'POST', body);
    const id = String(created.body.data!.id);
    const before = await stamp('cash_forecast_items');
    const out = await items.call(a, 'PUT', { ...body, id, description: '  Insurance  ' });
    expect(out.status).toBe(200);
    expect(out.body.data).toMatchObject({ id, amount: 100, category: 'loans' });
    expect(await stamp('cash_forecast_items')).toEqual(before);
    expect(await audit('cash_forecast_item')).toHaveLength(1);
    await clear();
  });

  it('override: 200 created:false, no UPDATE, no audit row', async () => {
    const body = { lineKey: 'payroll:net', weekStart: monday(1), mode: 'move_to', amount: null, targetWeekStart: monday(2), note: 'x' };
    expect((await overrides.call(a, 'PUT', body)).status).toBe(200);
    const before = await stamp('cash_forecast_overrides');
    const out = await overrides.call(a, 'PUT', body);
    expect(out.body.data).toMatchObject({ created: false, override: { mode: 'move_to', amount: null } });
    expect(await stamp('cash_forecast_overrides')).toEqual(before);
    expect(await audit('cash_forecast_override')).toHaveLength(1);
    await clear();
  });

  it('pay day: no UPDATE, no audit row', async () => {
    expect((await payDay.call(a, 'PUT', { kind: 'day_of_month', day: 28 })).status).toBe(200);
    const before = await stamp('payroll_company_settings');
    expect((await payDay.call(a, 'PUT', { kind: 'day_of_month', day: 28 })).body.data).toMatchObject({ isDefault: false, day: 28 });
    expect(await stamp('payroll_company_settings')).toEqual(before);
    expect(await audit('payroll_company_settings')).toHaveLength(1);
    await clear();
  });
});

describe('override order: the last edit wins', () => {
  it('set w3, move w2->w3, re-save set w3: the re-saved set lists (and adapts) last', async () => {
    const put = (b: Record<string, unknown>) => overrides.call(a, 'PUT', { lineKey: 'ap:s1', ...b });
    expect((await put({ weekStart: monday(3), mode: 'set', amount: -100000 })).status).toBe(200);
    expect((await put({ weekStart: monday(2), mode: 'move_to', amount: null, targetWeekStart: monday(3) })).status).toBe(200);
    expect((await put({ weekStart: monday(3), mode: 'set', amount: -150000 })).status).toBe(200);
    const listed = (await overrides.call(a, 'GET')).body.data!.overrides as StoredOverride[];
    expect(listed.map((o) => [o.mode, o.amount])).toEqual([['move_to', null], ['set', -150000]]);
    const engine = toEngineOverrides(listed, TODAY);
    expect(engine.map((o) => [o.mode, o.weekIndex, o.amountCents])).toEqual([['move_to', 2, null], ['set', 3, -15000000]]);
    await clear();
  });
});

describe('a note-only re-save keeps the application order (M2)', () => {
  /** The engine's set / whole-cell move_to, stubbed on one line's cells (rand): only the ORDER is under test. */
  const apply = (cells: Record<string, number>, list: StoredOverride[]) => {
    const c = { ...cells };
    for (const o of list) {
      if (o.mode === 'set') c[o.weekStart] = o.amount ?? 0;
      if (o.mode === 'move_to' && o.targetWeekStart) {
        const moved = o.amount === null ? (c[o.weekStart] ?? 0) : Math.sign(c[o.weekStart] ?? 0) * o.amount;
        c[o.weekStart] = (c[o.weekStart] ?? 0) - moved;
        c[o.targetWeekStart] = (c[o.targetWeekStart] ?? 0) + moved;
      }
    }
    return c;
  };

  it('set w3 -100000, move w2 -> w3 whole: -120000; a note-only re-save of the set leaves it -120000', async () => {
    const put = (b: Record<string, unknown>) => overrides.call(a, 'PUT', { lineKey: 'ap:s2', ...b });
    const setBody = { weekStart: monday(3), mode: 'set', amount: -100000 };
    expect((await put(setBody)).status).toBe(200);
    expect((await put({ weekStart: monday(2), mode: 'move_to', amount: null, targetWeekStart: monday(3) })).status).toBe(200);
    const cells = { [monday(2)]: -20000, [monday(3)]: -50000 };
    const list = async () => (await overrides.call(a, 'GET')).body.data!.overrides as StoredOverride[];
    expect(apply(cells, await list())[monday(3)]).toBe(-120000);
    const out = await put({ ...setBody, note: 'confirmed with supplier' });
    expect(out.body.data).toMatchObject({ created: false, override: { note: 'confirmed with supplier' } });
    const after = await list();
    expect(after.map((o) => o.mode)).toEqual(['set', 'move_to']);
    expect(apply(cells, after)[monday(3)]).toBe(-120000);
    // The note change is still audited.
    expect((await audit('cash_forecast_override')).map((r) => r.action)).toEqual(['create', 'create', 'update']);
    await clear();
  });
});

describe("an override on a manual item's line (L8)", () => {
  it("needs the item to exist for the company (404); a key that names no UUID is 400; nothing written", async () => {
    const id = String((await items.call(a, 'POST', ITEM)).body.data!.id);
    const body = { weekStart: monday(1), mode: 'set', amount: -50 };
    expect((await overrides.call(a, 'PUT', { ...body, lineKey: `manual:${id}` })).status).toBe(200);
    expect((await overrides.call(a, 'PUT', { ...body, lineKey: `manual:${crypto.randomUUID()}` })).status).toBe(404);
    expect((await overrides.call(a, 'PUT', { ...body, lineKey: 'manual:not-a-uuid' })).status).toBe(400);
    expect((await overrides.call(a, 'PUT', { ...body, lineKey: 'MANUAL:not-a-uuid' })).status).toBe(400);
    expect((await pool.query('SELECT line_key FROM cash_forecast_overrides WHERE company_id = $1', [co()])).rows)
      .toEqual([{ line_key: `manual:${id}` }]);
    await clear();
  });

  it('an uppercase key is stored canonical (lowercase) and so goes with the item on delete', async () => {
    const id = String((await items.call(a, 'POST', ITEM)).body.data!.id);
    const out = await overrides.call(a, 'PUT', { weekStart: monday(2), mode: 'set', amount: -5, lineKey: `MANUAL:${id.toUpperCase()}` });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect((out.body.data!.override as { lineKey: string }).lineKey).toBe(`manual:${id}`);
    expect((await items.call(a, 'DELETE', undefined, { id })).status).toBe(200);
    expect((await pool.query('SELECT COUNT(*)::int n FROM cash_forecast_overrides WHERE company_id = $1', [co()])).rows[0].n).toBe(0);
    await clear();
  });
});

describe('write rate limit (security LOW)', () => {
  it('with the user\'s bucket full (120 a minute, shared by the three routes), every write is 429 and writes nothing; reads still pass', async () => {
    const id = String((await items.call(a, 'POST', ITEM)).body.data!.id);
    const key = `cash13-write:${a.userId}`;
    await pool.query(`INSERT INTO rate_limit_counters (key, count, window_start) VALUES ($1, 120, now())
                      ON CONFLICT (key) DO UPDATE SET count = 120, window_start = now()`, [key]);
    clearRateLimitCache();
    try {
      const before = (await audit('cash_forecast_item')).length;
      const writes = [
        await items.call(a, 'POST', ITEM), await items.call(a, 'PUT', { ...ITEM, id, amount: 7 }), await items.call(a, 'DELETE', undefined, { id }),
        await overrides.call(a, 'PUT', { lineKey: 'payroll:net', weekStart: monday(1), mode: 'set', amount: 1 }),
        await overrides.call(a, 'DELETE', undefined, { id: crypto.randomUUID() }),
        await payDay.call(a, 'PUT', { kind: 'day_of_month', day: 3 }),
      ];
      expect(writes.map((w) => [w.status, (w.body.error as { code?: string } | undefined)?.code])).toEqual(Array(6).fill([429, 'RATE_LIMIT']));
      expect((await pool.query('SELECT amount::float a FROM cash_forecast_items WHERE id = $1', [id])).rows).toEqual([{ a: 100 }]);
      expect(await audit('cash_forecast_item')).toHaveLength(before);
      expect((await pool.query('SELECT COUNT(*)::int n FROM cash_forecast_overrides WHERE company_id = $1', [co()])).rows[0].n).toBe(0);
      expect((await pool.query('SELECT COUNT(*)::int n FROM payroll_company_settings WHERE company_id = $1', [co()])).rows[0].n).toBe(0);
      expect((await items.call(a, 'GET')).status).toBe(200);
    } finally {
      await pool.query('DELETE FROM rate_limit_counters WHERE key = $1', [key]);
      clearRateLimitCache();
      await clear();
    }
  });
});

describe('pay day not chosen', () => {
  it('a settings row with only 999a columns reads as the default (day 25, isDefault)', async () => {
    await seedAs('INSERT INTO payroll_company_settings (company_id, pay_weekday) VALUES ($1, 4)', [co()]);
    expect((await payDay.call(a, 'GET')).body.data).toEqual({ payDay: { kind: 'day_of_month', day: 25 }, day: 25, isDefault: true });
    await clear();
  });
});
