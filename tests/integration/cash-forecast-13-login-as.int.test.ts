/**
 * The 13-week cash forecast's writes refuse a Login-as session (403 IMPERSONATION_FORBIDDEN) on every
 * write method, writing nothing (no row, no audit row); a read is allowed; the target's own session may write.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import itemsRoute from '../../pages/api/accounting/cash-forecast-13/items';
import overridesRoute from '../../pages/api/accounting/cash-forecast-13/overrides';
import payDayRoute from '../../pages/api/accounting/cash-forecast-13/pay-day';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture, reasonOf, type Jar } from './r-032-login-as.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = loginAsFixture(pool, 'Cash13 Login-as');
let loginAs: Jar;
let itemId = '', overrideId = '';

const ITEM = { direction: 'payment', amount: 100, date: '2026-12-01', description: 'Insurance' };
const OVR = { lineKey: 'payroll:net', weekStart: '2026-11-23', mode: 'add', amount: -50 };

const snapshot = async () => ({
  items: (await pool.query('SELECT id, amount::text FROM cash_forecast_items WHERE company_id = $1 ORDER BY id', [fx.company])).rows,
  overrides: (await pool.query('SELECT id, amount::text FROM cash_forecast_overrides WHERE company_id = $1 ORDER BY id', [fx.company])).rows,
  settings: (await pool.query('SELECT salary_pay_rule, salary_pay_day FROM payroll_company_settings WHERE company_id = $1', [fx.company])).rows,
  audit: (await pool.query('SELECT COUNT(*)::int n FROM audit_log WHERE company_id = $1', [fx.company])).rows[0].n,
});

beforeAll(async () => {
  await fx.setUp();
  const own = await fx.ownSession();
  const i = await fx.call(itemsRoute as never, own, { method: 'POST', body: ITEM, url: '/api/accounting/cash-forecast-13/items' });
  expect(i.state.statusCode, JSON.stringify(i.state.body)).toBe(201);
  itemId = (i.state.body as { data: { id: string } }).data.id;
  const o = await fx.call(overridesRoute as never, own, { method: 'PUT', body: OVR, url: '/api/accounting/cash-forecast-13/overrides' });
  expect(o.state.statusCode, JSON.stringify(o.state.body)).toBe(200);
  overrideId = (o.state.body as { data: { override: { id: string } } }).data.override.id;
  loginAs = await fx.loginAsTarget();
}, 60_000);
afterAll(async () => {
  try {
    for (const t of ['cash_forecast_items', 'cash_forecast_overrides', 'payroll_company_settings']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [fx.company]);
    }
    await fx.tearDown();
  } finally { await pool.end(); }
});

describe('Login-as is refused on every write', () => {
  const cases: Array<[string, unknown, string, Record<string, string> | undefined, () => unknown]> = [
    ['items POST', itemsRoute, 'POST', undefined, () => ITEM],
    ['items PUT', itemsRoute, 'PUT', undefined, () => ({ ...ITEM, id: itemId, amount: 1 })],
    ['items DELETE', itemsRoute, 'DELETE', {}, () => undefined],
    ['overrides PUT', overridesRoute, 'PUT', undefined, () => ({ ...OVR, amount: 7 })],
    ['overrides DELETE', overridesRoute, 'DELETE', {}, () => undefined],
    ['pay-day PUT', payDayRoute, 'PUT', undefined, () => ({ kind: 'day_of_month', day: 1 })],
  ];
  it.each(cases)('%s: 403, nothing written', async (name, route, method, query, body) => {
    const before = await snapshot();
    const q = query === undefined ? {} : { id: name.startsWith('items') ? itemId : overrideId };
    const r = await fx.call(route as never, loginAs, { method, body: body(), query: q, url: '/api/accounting/cash-forecast-13' });
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(403);
    expect(reasonOf(r)).toBe('IMPERSONATION_FORBIDDEN');
    expect(await snapshot()).toEqual(before);
  });

  it('a Login-as read is allowed', async () => {
    const r = await fx.call(itemsRoute as never, loginAs, { method: 'GET', url: '/api/accounting/cash-forecast-13/items' });
    expect(r.state.statusCode).toBe(200);
  });

  it("the target's own session may write", async () => {
    const r = await fx.call(payDayRoute as never, await fx.ownSession(), { method: 'PUT', body: { kind: 'last_working_day' }, url: '/api/accounting/cash-forecast-13/pay-day' });
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(200);
  });
});
