/**
 * Per-company caps of the 13-week cash forecast's stored inputs count only LIVE entries:
 *   - items: one-offs dated on or after this week's Monday, and repeats with no end or an end on or after today;
 *   - overrides: weeks on or after this week's Monday.
 * At 500 live items / 2000 live overrides a new one is 409, and the message says how many live entries exist;
 * re-saving an existing override cell is not capped. Counted under a per-company lock, so two concurrent creates
 * at the cap cannot both pass (the race is forced).
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import itemsRoute from '../../pages/api/accounting/cash-forecast-13/items';
import overridesRoute from '../../pages/api/accounting/cash-forecast-13/overrides';
import { addDaysISO } from '@/lib/dateUtils';
import { appToday } from '@/modules/accounting/services/reports/dueByDateService';
import { horizonStart } from '@/modules/accounting/services/cashForecast13/engineAdapter';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const items = budgetsRouteFixture(pool, itemsRoute, '/api/accounting/cash-forecast-13/items');
const overrides = budgetsRouteFixture(pool, overridesRoute, '/api/accounting/cash-forecast-13/overrides');

let a: SetupUser;
const today = appToday();
const monday = (k: number) => addDaysISO(horizonStart(today), 7 * k);
const ITEM = () => ({ direction: 'payment', amount: 100, date: monday(2), description: 'Insurance' });
const co = () => a.homeCompanyId;

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
/** n items: kind 'live' (one-off at monday(1)), 'open' (weekly from last year, no end), 'ends_today', 'past' (one-off
 * the day before this Monday), 'ended' (weekly that ended yesterday). */
const seedItems = (n: number, kind: 'live' | 'open' | 'ends_today' | 'past' | 'ended') => {
  const [date, repeat, until] = {
    live: [monday(1), 'none', null], open: [addDaysISO(today, -300), 'weekly', null], ends_today: [addDaysISO(today, -60), 'monthly', today],
    past: [addDaysISO(monday(0), -1), 'none', null], ended: [addDaysISO(today, -60), 'weekly', addDaysISO(today, -1)],
  }[kind];
  return seedAs(
    `INSERT INTO cash_forecast_items (company_id, direction, amount, expected_date, repeat, repeat_until, description)
     SELECT $1, 'receipt', 1, $3::date, $4, $5::date, 'seed ' || g FROM generate_series(1, $2) g`, [co(), n, date, repeat, until]);
};
const seedOverrides = (n: number, week: string, prefix: string) => seedAs(
  `INSERT INTO cash_forecast_overrides (company_id, line_key, week_start, mode, amount)
   SELECT $1, $4 || g, $3::date, 'set', 1 FROM generate_series(1, $2) g`, [co(), n, week, prefix]);
const count = async (t: string) => (await pool.query(`SELECT COUNT(*)::int n FROM ${t} WHERE company_id = $1`, [co()])).rows[0].n as number;
const clear = async () => {
  for (const t of ['cash_forecast_items', 'cash_forecast_overrides', 'audit_log']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [co()]);
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

beforeAll(async () => { a = (await items.owner()).u; }, 60_000);
afterAll(async () => {
  try { await clear(); await items.cleanup(); } finally { await pool.end(); }
});

describe('items: 500 live per company', () => {
  it('past one-offs and ended repeats do not count; live ones, open repeats and repeats ending today do', async () => {
    await seedItems(300, 'past');
    await seedItems(300, 'ended');
    await seedItems(200, 'live');
    await seedItems(200, 'open');
    await seedItems(99, 'ends_today');
    expect((await items.call(a, 'POST', ITEM())).status).toBe(201); // the 500th live
    const out = await items.call(a, 'POST', ITEM());
    expect(out.status).toBe(409);
    expect(out.body.error?.message).toMatch(/500 live/);
    expect(await count('cash_forecast_items')).toBe(1100);
    await clear();
  });

  it('a past one-off dated before this Monday is the boundary: one dated this Monday counts', async () => {
    await seedItems(499, 'live');
    await seedAs(`INSERT INTO cash_forecast_items (company_id, direction, amount, expected_date, description) VALUES ($1, 'receipt', 1, $2, 'mon')`, [co(), monday(0)]);
    expect((await items.call(a, 'POST', ITEM())).status).toBe(409);
    await clear();
  });

  it('two concurrent creates at 499 live: exactly one passes (forced race)', async () => {
    await seedItems(499, 'live');
    const out = await forcedRace('cash_forecast_items', () => items.call(a, 'POST', ITEM()));
    expect(out.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await count('cash_forecast_items')).toBe(500);
    await clear();
  });
});

describe('dead rows (security review): no creating them, a hard total cap, no revival past the live cap', () => {
  it('creating a one-off before this Monday, an ended repeat or a past-week override is 400; nothing written', async () => {
    const one = await items.call(a, 'POST', { ...ITEM(), date: addDaysISO(monday(0), -1) });
    expect(one.status).toBe(400);
    expect(one.body.error?.message).toMatch(/this week or later/);
    expect((await items.call(a, 'POST', { ...ITEM(), date: addDaysISO(today, -30), repeat: 'weekly', repeatUntil: addDaysISO(today, -1) })).status).toBe(400);
    expect((await items.call(a, 'POST', { ...ITEM(), date: monday(0) })).status).toBe(201);
    expect((await overrides.call(a, 'PUT', { lineKey: 'payroll:net', weekStart: monday(-1), mode: 'set', amount: 1 })).status).toBe(400);
    expect(await count('cash_forecast_overrides')).toBe(0);
    await clear();
  });

  it('editing an item into the past parks it (allowed); re-saving an existing past override is allowed', async () => {
    const id = String((await items.call(a, 'POST', ITEM())).body.data!.id);
    expect((await items.call(a, 'PUT', { ...ITEM(), id, date: addDaysISO(monday(0), -7) })).status).toBe(200);
    await seedOverrides(1, monday(-1), 'old:');
    expect((await overrides.call(a, 'PUT', { lineKey: 'old:1', weekStart: monday(-1), mode: 'set', amount: 5 })).status).toBe(200);
    await clear();
  });

  it('2000 items in all (dead ones included): a new live item is 409 naming the total cap', async () => {
    await seedItems(2000, 'past');
    const out = await items.call(a, 'POST', ITEM());
    expect(out.status).toBe(409);
    expect(out.body.error?.message).toMatch(/Total items cap.*2000/);
    await clear();
  });

  it('10000 overrides in all (past weeks included): a new live cell is 409 naming the total cap', async () => {
    await seedOverrides(10000, monday(-1), 'past:');
    const out = await overrides.call(a, 'PUT', { lineKey: 'payroll:net', weekStart: monday(1), mode: 'set', amount: 1 });
    expect(out.status).toBe(409);
    expect(out.body.error?.message).toMatch(/Total overrides cap.*10000/);
    await clear();
  });

  it('at 500 live, bringing a parked item back to life is 409; editing it while it stays parked is not', async () => {
    await seedItems(500, 'live');
    await seedItems(1, 'past');
    const parked = (await pool.query("SELECT id FROM cash_forecast_items WHERE company_id = $1 AND expected_date < $2", [co(), monday(0)])).rows[0].id;
    const out = await items.call(a, 'PUT', { ...ITEM(), id: parked, date: monday(1) });
    expect(out.status).toBe(409);
    expect(out.body.error?.message).toMatch(/Live items cap/);
    expect((await items.call(a, 'PUT', { ...ITEM(), id: parked, date: addDaysISO(monday(0), -1), description: 'still parked' })).status).toBe(200);
    await clear();
  });

  it('below the live cap a parked item comes back to life', async () => {
    await seedItems(499, 'live');
    await seedItems(1, 'past');
    const parked = (await pool.query("SELECT id FROM cash_forecast_items WHERE company_id = $1 AND expected_date < $2", [co(), monday(0)])).rows[0].id;
    expect((await items.call(a, 'PUT', { ...ITEM(), id: parked, date: monday(1) })).status).toBe(200);
    await clear();
  });
});

describe('overrides: 2000 live per company', () => {
  it('past weeks do not count; at 2000 live a new cell is 409 (with the count); re-saving a cell passes', async () => {
    await seedOverrides(500, monday(-1), 'past:');
    await seedOverrides(2000, monday(1), 'seed:');
    const out = await overrides.call(a, 'PUT', { lineKey: 'payroll:net', weekStart: monday(1), mode: 'set', amount: 1 });
    expect(out.status).toBe(409);
    expect(out.body.error?.message).toMatch(/2000 live/);
    expect((await overrides.call(a, 'PUT', { lineKey: 'seed:7', weekStart: monday(1), mode: 'set', amount: 2 })).status).toBe(200);
    await clear();
  });

  it('with 1999 live and many past, a new cell passes', async () => {
    await seedOverrides(500, monday(-1), 'past:');
    await seedOverrides(1999, monday(1), 'seed:');
    expect((await overrides.call(a, 'PUT', { lineKey: 'payroll:net', weekStart: monday(0), mode: 'set', amount: 1 })).status).toBe(200);
    await clear();
  });

  it('two concurrent new cells at 1999 live: exactly one passes (forced race)', async () => {
    await seedOverrides(1999, monday(1), 'seed:');
    let n = 0;
    const out = await forcedRace('cash_forecast_overrides', () =>
      overrides.call(a, 'PUT', { lineKey: `race:${n++}`, weekStart: monday(1), mode: 'set', amount: 1 }));
    expect(out.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await count('cash_forecast_overrides')).toBe(2000);
    await clear();
  });
});
