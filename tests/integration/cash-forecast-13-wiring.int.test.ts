/**
 * The stored inputs (999i) end to end, through the real routes, the adapter and the real engine:
 *   - the reviewer's override sequences through applyOverrides: the last figure edit wins (week 3 = -150000)
 *     and a note-only re-save keeps the order (week 3 stays -120000);
 *   - GET /api/accounting/cash-forecast-13 shows a stored manual item, an override on its line and the stored
 *     salary pay day.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import cashForecastRoute from '../../pages/api/accounting/cash-forecast-13';
import itemsRoute from '../../pages/api/accounting/cash-forecast-13/items';
import overridesRoute from '../../pages/api/accounting/cash-forecast-13/overrides';
import payDayRoute from '../../pages/api/accounting/cash-forecast-13/pay-day';
import { addDaysISO } from '@/lib/dateUtils';
import { clearRateLimitCache } from '@/lib/rateLimit';
import { appToday } from '@/modules/accounting/services/reports/dueByDateService';
import { applyOverrides } from '@/modules/accounting/services/cashForecast13/adjustments';
import { horizonStart, toEngineOverrides } from '@/modules/accounting/services/cashForecast13/engineAdapter';
import { emptyWeekly } from '@/modules/accounting/services/cashForecast13/lines';
import { payDateOf } from '@/modules/accounting/services/cashForecast13/payDates';
import { listOverrides, type StoredOverride } from '@/modules/accounting/services/cashForecast13/overridesRepo';
import type { CashForecast13, ForecastLine } from '@/modules/accounting/services/cashForecast13/types';
import { weekIndexOf, buildWeeks } from '@/modules/accounting/services/cashForecast13/weeks';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetThreeWayFixture, dataOf, type ThreeWayCo } from './helpers/budgetThreeWayFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetThreeWayFixture(pool);
const today = appToday();
const monday = (k: number) => addDaysISO(horizonStart(today), 7 * k);
const prevMonth = (() => { const [y, m] = today.split('-').map(Number) as [number, number]; return m === 1 ? [y - 1, 12] : [y, m - 1]; })();
let A: ThreeWayCo;

const call = (route: unknown, url: string, method: string, body?: unknown, query: Record<string, string> = {}) =>
  fx.call(route, `/api/accounting/cash-forecast-13${url}`, A.owner, method, query, body);
const clearStore = async () => {
  for (const t of ['cash_forecast_items', 'cash_forecast_overrides', 'payroll_company_settings']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [A.id]);
};

beforeAll(async () => {
  A = await fx.company();
  await pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_net, total_paye, total_uif, total_sdl)
     VALUES ($1, $2, $3, 'approved', 9000, 1500, 200, 100)`, [A.id, prevMonth[0], prevMonth[1]]);
}, 120000);
afterAll(async () => {
  try {
    await clearStore();
    await pool.query('DELETE FROM audit_log WHERE company_id = $1', [A.id]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [A.id]);
    await pool.query('DELETE FROM rate_limit_counters WHERE key = $1', [`report:cash-forecast-13:co:${A.id}`]);
    clearRateLimitCache();
    await fx.cleanup();
  } finally { await pool.end(); }
});

describe('the reviewer sequences through the real engine applier', () => {
  /** A supplier line: -20000 in week 2, -50000 in week 3 (rand). */
  const line = (): ForecastLine => {
    const weekly = emptyWeekly();
    weekly[2] = -2_000_000; weekly[3] = -5_000_000;
    return { key: 'ap:s1', label: 'Supplier', category: 'supplier_payments', kind: 'known', weekly, totalCents: -7_000_000, flags: [], items: [] };
  };
  const week3 = async (): Promise<number> => {
    const listed = dataOf<{ overrides: StoredOverride[] }>(await call(overridesRoute, '/overrides', 'GET')).overrides;
    const { lines, warnings } = applyOverrides([line()], toEngineOverrides(listed, today));
    expect(warnings).toEqual([]);
    return (line().weekly[3]! + (lines[0]?.weekly[3] ?? 0)) / 100;
  };
  const put = async (b: Record<string, unknown>) => expect((await call(overridesRoute, '/overrides', 'PUT', { lineKey: 'ap:s1', ...b })).status).toBe(200);

  it('set w3 -100000, move w2 -> w3 whole, re-save the set at -150000: week 3 = -150000 (the last edit wins)', async () => {
    await put({ weekStart: monday(3), mode: 'set', amount: -100000 });
    await put({ weekStart: monday(2), mode: 'move_to', amount: null, targetWeekStart: monday(3) });
    await put({ weekStart: monday(3), mode: 'set', amount: -150000 });
    expect(await week3()).toBe(-150000);
    await clearStore();
  });

  it('set w3 -100000, move w2 -> w3 whole: -120000; a note-only re-save of the set keeps -120000', async () => {
    await put({ weekStart: monday(3), mode: 'set', amount: -100000 });
    await put({ weekStart: monday(2), mode: 'move_to', amount: null, targetWeekStart: monday(3) });
    expect(await week3()).toBe(-120000);
    await put({ weekStart: monday(3), mode: 'set', amount: -100000, note: 'confirmed' });
    expect(await week3()).toBe(-120000);
    await clearStore();
  });
});

describe('listOverrides', () => {
  it('lists every override for management, and only this week on for the engine (fromMonday)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: A.owner.userId })]);
      await c.query(`INSERT INTO cash_forecast_overrides (company_id, line_key, week_start, mode, amount)
                     VALUES ($1, 'old', $2, 'set', 1), ($1, 'now', $3, 'set', 1)`, [A.id, monday(-1), monday(0)]);
      await c.query('COMMIT');
    } finally { c.release(); }
    expect((await fx.direct(A, () => listOverrides(A.id))).map((o) => o.lineKey).sort()).toEqual(['now', 'old']);
    expect((await fx.direct(A, () => listOverrides(A.id, monday(0)))).map((o) => o.lineKey)).toEqual(['now']);
    await clearStore();
  });
});

describe('GET /api/accounting/cash-forecast-13 reads the stored inputs', () => {
  it('a manual item, an override on its line and the stored pay day all show up', async () => {
    expect((await call(payDayRoute, '/pay-day', 'PUT', { kind: 'last_working_day' })).status).toBe(200);
    const date = addDaysISO(today, 7);
    const item = await call(itemsRoute, '/items', 'POST', { direction: 'receipt', amount: 1000, date, description: 'Deposit' });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    const id = String((item.body.data as { id: string }).id);
    const weeks = buildWeeks(today);
    const w = weekIndexOf(date, today, weeks)!;
    expect((await call(overridesRoute, '/overrides', 'PUT', { lineKey: `manual:${id}`, weekStart: weeks[w]!.start, mode: 'set', amount: 2500 })).status).toBe(200);

    const r = await call(cashForecastRoute, '', 'GET');
    expect(r.status, JSON.stringify(r.body).slice(0, 400)).toBe(200);
    const f = dataOf<CashForecast13>(r);
    expect(f.lines.find((l) => l.key === `manual:${id}`)?.totalCents).toBe(100_000);
    expect(f.lines.find((l) => l.key === `override:manual:${id}`)?.weekly[w]).toBe(150_000);
    const pay = f.lines.find((l) => l.key === 'payroll:net')!;
    expect(pay.items.length).toBeGreaterThan(0);
    for (const i of pay.items) expect(i.date).toBe(payDateOf('last_working_day', i.date.slice(0, 7)));
    expect(pay.items.some((i) => i.date !== payDateOf(25, i.date.slice(0, 7)))).toBe(true);
    await clearStore();
  });
});
