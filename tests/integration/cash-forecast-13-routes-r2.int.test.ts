/**
 * Review round 2 of /api/accounting/cash-forecast-13/*, as real members through withAuth's request transaction:
 *   - an item's account must be active and a leaf (a header is 400);
 *   - deleting an item deletes its 'manual:<id>' overrides in the same transaction, each audited;
 *   - a save with nothing changed writes no row change and no audit row (items, overrides, pay day);
 *   - per-company caps: 500 items, 2000 overrides (409), checked under a lock so two concurrent creates at
 *     the cap cannot both pass; re-saving an existing override cell is not capped;
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
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { horizonStart, toEngineOverrides } from '@/modules/accounting/services/cashForecast13/engineAdapter';
import type { StoredOverride } from '@/modules/accounting/services/cashForecast13/overridesRepo';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const items = budgetsRouteFixture(pool, itemsRoute, '/api/accounting/cash-forecast-13/items');
const overrides = budgetsRouteFixture(pool, overridesRoute, '/api/accounting/cash-forecast-13/overrides');
const payDay = budgetsRouteFixture(pool, payDayRoute, '/api/accounting/cash-forecast-13/pay-day');

let a: SetupUser, leaf = '', header = '', inactive = '';
const ITEM = { direction: 'payment', amount: 100, date: '2026-12-01', description: 'Insurance' };
const TODAY = new Date().toISOString().slice(0, 10);
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

/**
 * Two concurrent calls with the race forced: SHARE ROW EXCLUSIVE on `table` lets COUNT(*) through but blocks
 * INSERT. Without the per-company lock both requests count below the cap and wait at their INSERT; with it, the
 * second waits on the advisory lock until the first commits. Released once both are waiting.
 */
async function forcedRace<T>(table: string, call: () => Promise<T>): Promise<T[]> {
  const locker = await pool.connect();
  await locker.query('BEGIN');
  await locker.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
  const pid = (await locker.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  const calls = Promise.all([call(), call()]);
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const waiting = (await pool.query(
        "SELECT COUNT(*)::int n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> $1", [pid])).rows[0].n;
      if (waiting >= 2) break;
      if (Date.now() > deadline) throw new Error(`only ${waiting} request(s) reached a lock wait`);
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    await locker.query('COMMIT');
    locker.release();
  }
  return calls;
}

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
    const body = { ...ITEM, accountId: leaf, repeat: 'monthly', repeatUntil: '2027-03-01', category: 'loans' };
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

describe('per-company caps', () => {
  const seedItems = (n: number) => seedAs(
    `INSERT INTO cash_forecast_items (company_id, direction, amount, expected_date, description)
     SELECT $1, 'receipt', 1, '2026-12-01', 'seed ' || g FROM generate_series(1, $2) g`, [co(), n]);

  it('the 501st item is 409 and writes nothing; after a delete the next create passes', async () => {
    await seedItems(500);
    const out = await items.call(a, 'POST', ITEM);
    expect(out.status).toBe(409);
    expect(out.body.error?.message).toMatch(/500/);
    expect((await pool.query('SELECT COUNT(*)::int n FROM cash_forecast_items WHERE company_id = $1', [co()])).rows[0].n).toBe(500);
    const one = (await pool.query('SELECT id FROM cash_forecast_items WHERE company_id = $1 LIMIT 1', [co()])).rows[0].id;
    expect((await items.call(a, 'DELETE', undefined, { id: one })).status).toBe(200);
    expect((await items.call(a, 'POST', ITEM)).status).toBe(201);
    await clear();
  });

  it('two concurrent creates at 499: exactly one passes (forced race)', async () => {
    await seedItems(499);
    const calls = forcedRace('cash_forecast_items', () => items.call(a, 'POST', ITEM));
    const statuses = (await calls).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect((await pool.query('SELECT COUNT(*)::int n FROM cash_forecast_items WHERE company_id = $1', [co()])).rows[0].n).toBe(500);
    await clear();
  });

  it('two concurrent new override cells at 1999: exactly one passes (forced race)', async () => {
    await seedAs(
      `INSERT INTO cash_forecast_overrides (company_id, line_key, week_start, mode, amount)
       SELECT $1, 'seed:' || g, $2::date, 'set', 1 FROM generate_series(1, 1999) g`, [co(), monday(1)]);
    let n = 0;
    const out = await forcedRace('cash_forecast_overrides', () =>
      overrides.call(a, 'PUT', { lineKey: `race:${n++}`, weekStart: monday(1), mode: 'set', amount: 1 }));
    expect(out.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await pool.query('SELECT COUNT(*)::int n FROM cash_forecast_overrides WHERE company_id = $1', [co()])).rows[0].n).toBe(2000);
    await clear();
  });

  it('the 2001st override cell is 409; re-saving an existing cell at the cap passes', async () => {
    await seedAs(
      `INSERT INTO cash_forecast_overrides (company_id, line_key, week_start, mode, amount)
       SELECT $1, 'seed:' || g, $2::date, 'set', 1 FROM generate_series(1, 2000) g`, [co(), monday(1)]);
    const out = await overrides.call(a, 'PUT', { lineKey: 'payroll:net', weekStart: monday(1), mode: 'set', amount: 1 });
    expect(out.status).toBe(409);
    expect(out.body.error?.message).toMatch(/2000/);
    expect((await overrides.call(a, 'PUT', { lineKey: 'seed:7', weekStart: monday(1), mode: 'set', amount: 2 })).status).toBe(200);
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

describe('pay day not chosen', () => {
  it('a settings row with only 999a columns reads as the default (day 25, isDefault)', async () => {
    await seedAs('INSERT INTO payroll_company_settings (company_id, pay_weekday) VALUES ($1, 4)', [co()]);
    expect((await payDay.call(a, 'GET')).body.data).toEqual({ payDay: { kind: 'day_of_month', day: 25 }, day: 25, isDefault: true });
    await clear();
  });
});
