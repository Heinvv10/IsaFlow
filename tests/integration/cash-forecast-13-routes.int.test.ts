/**
 * /api/accounting/cash-forecast-13/{items,overrides,pay-day} called as real members through withAuth's
 * request transaction (app_user, RLS, CSRF):
 *   - an owner adds, edits and removes an item; saves (upserts) and removes an override; sets the pay day;
 *     each write leaves one audit row by that user with old/new values;
 *   - a viewer reads but cannot write (403); a write without the CSRF token is refused (403);
 *   - company B neither sees A's rows nor edits/deletes them (404); an account of B is a 400 for A;
 *   - invalid bodies (a Tuesday week, 30 February) are 400 and write nothing.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import itemsRoute from '../../pages/api/accounting/cash-forecast-13/items';
import overridesRoute from '../../pages/api/accounting/cash-forecast-13/overrides';
import payDayRoute from '../../pages/api/accounting/cash-forecast-13/pay-day';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import { signSession } from './r-032-fake-gotrue.helpers';
import { addDaysISO } from '@/lib/dateUtils';
import { appToday } from '@/modules/accounting/services/reports/dueByDateService';
import { horizonStart } from '@/modules/accounting/services/cashForecast13/engineAdapter';
import type { SetupUser } from './helpers/onboardingSetupFixture';

/** This week's Monday + k weeks (relative, so the suite never ages into the past). */
const wk = (k: number, d = 0) => addDaysISO(horizonStart(appToday()), 7 * k + d);
assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const items = budgetsRouteFixture(pool, itemsRoute, '/api/accounting/cash-forecast-13/items');
const overrides = budgetsRouteFixture(pool, overridesRoute, '/api/accounting/cash-forecast-13/overrides');
const payDay = budgetsRouteFixture(pool, payDayRoute, '/api/accounting/cash-forecast-13/pay-day');

const members: string[] = [];
let a: SetupUser, b: SetupUser, viewer: SetupUser, accountA = '', accountB = '';
let itemId = '', overrideId = '';

async function member(companyId: string, role: string): Promise<SetupUser> {
  const userId = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed, first_name, last_name)
                    VALUES ($1, $2, 'admin', true, true, 'Vee', 'Ewer')`, [userId, `${userId}@test.local`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, $3, true)`, [companyId, userId, role]);
  members.push(userId);
  return { userId, homeCompanyId: companyId, token: await signSession(userId, undefined, 'aal2') };
}

const audit = async (co: string, entityType: string) => (await pool.query(
  `SELECT action, user_id, entity_id::text AS entity_id, changes FROM audit_log WHERE company_id = $1 AND entity_type = $2 ORDER BY created_at, id`,
  [co, entityType])).rows;
const count = async (table: string, co: string) =>
  (await pool.query(`SELECT COUNT(*)::int n FROM ${table} WHERE company_id = $1`, [co])).rows[0].n as number;

const ITEM = { direction: 'receipt', amount: 12500.5, date: wk(2, 1), repeat: 'monthly', repeatUntil: wk(14), description: 'Retainer', category: 'customer_receipts' };
const OVR = { lineKey: 'payroll:net', weekStart: wk(1), mode: 'set', amount: 80000 };

beforeAll(async () => {
  const oa = await items.owner(); a = oa.u; accountA = oa.account;
  const ob = await items.owner(); b = ob.u; accountB = ob.account;
  viewer = await member(a.homeCompanyId, 'viewer');
}, 60_000);
afterAll(async () => {
  try {
    for (const co of [a.homeCompanyId, b.homeCompanyId]) {
      for (const t of ['cash_forecast_items', 'cash_forecast_overrides', 'payroll_company_settings', 'audit_log']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [co]);
      }
    }
    await items.cleanup();
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1)', [members]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [members]);
  } finally { await pool.end(); }
});

describe('items', () => {
  it('the owner adds an item (201) stamped by the trigger, with one create audit row', async () => {
    const out = await items.call(a, 'POST', { ...ITEM, accountId: accountA });
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    expect(out.body.data).toMatchObject({ ...ITEM, accountId: accountA });
    itemId = String(out.body.data!.id);
    const row = (await pool.query('SELECT created_by, updated_by FROM cash_forecast_items WHERE id = $1', [itemId])).rows[0];
    expect(row).toEqual({ created_by: a.userId, updated_by: a.userId });
    const rows = await audit(a.homeCompanyId, 'cash_forecast_item');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'create', user_id: a.userId, entity_id: itemId });
  });

  it('GET lists it for the owner and for a viewer', async () => {
    for (const u of [a, viewer]) {
      const out = await items.call(u, 'GET');
      expect(out.status).toBe(200);
      expect((out.body.data!.items as unknown[]).map((i) => (i as { id: string }).id)).toEqual([itemId]);
    }
  });

  it('the owner edits it (200); the audit row has the old and new amount', async () => {
    const out = await items.call(a, 'PUT', { ...ITEM, id: itemId, amount: 13000, accountId: accountA });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.data!.amount).toBe(13000);
    const rows = await audit(a.homeCompanyId, 'cash_forecast_item');
    expect(rows).toHaveLength(2);
    expect(rows[1].action).toBe('update');
    expect(rows[1].changes.fields).toEqual([{ field: 'amount', label: 'Amount', old: '12500.5', new: '13000' }]);
  });

  it('a viewer cannot add, edit or remove (403), and nothing changes', async () => {
    expect((await items.call(viewer, 'POST', ITEM)).status).toBe(403);
    expect((await items.call(viewer, 'PUT', { ...ITEM, id: itemId })).status).toBe(403);
    expect((await items.call(viewer, 'DELETE', undefined, { id: itemId })).status).toBe(403);
    expect(await count('cash_forecast_items', a.homeCompanyId)).toBe(1);
  });

  it('a write without the CSRF token is refused (403) and writes nothing', async () => {
    const req = request({ 'sb-access-token': a.token, active_company_id: a.homeCompanyId }, 'POST') as unknown as
      { url: string; query: Record<string, string>; body: unknown; headers: Record<string, string> };
    delete req.headers['x-csrf-token'];
    req.url = '/api/accounting/cash-forecast-13/items';
    req.query = {};
    req.body = ITEM;
    const out = response();
    await (itemsRoute as unknown as (q: never, s: never) => Promise<unknown>)(req as never, out.res as never);
    expect(out.state.statusCode).toBe(403);
    expect(await count('cash_forecast_items', a.homeCompanyId)).toBe(1);
  });

  it("company B does not see A's item and cannot edit or remove it (404)", async () => {
    expect((await items.call(b, 'GET')).body.data!.items).toEqual([]);
    expect((await items.call(b, 'PUT', { ...ITEM, id: itemId })).status).toBe(404);
    expect((await items.call(b, 'DELETE', undefined, { id: itemId })).status).toBe(404);
    expect(await count('cash_forecast_items', a.homeCompanyId)).toBe(1);
  });

  it("an account of another company is a 400 and writes nothing", async () => {
    const out = await items.call(a, 'POST', { ...ITEM, accountId: accountB });
    expect(out.status).toBe(400);
    expect(await count('cash_forecast_items', a.homeCompanyId)).toBe(1);
  });

  it('30 February and a blank description are 400', async () => {
    expect((await items.call(a, 'POST', { ...ITEM, date: '2026-02-30' })).status).toBe(400);
    expect((await items.call(a, 'POST', { ...ITEM, description: '  ' })).status).toBe(400);
    expect(await audit(a.homeCompanyId, 'cash_forecast_item')).toHaveLength(2);
  });

  it('the owner removes it (200) with a delete audit row; a second remove is 404', async () => {
    expect((await items.call(a, 'DELETE', undefined, { id: itemId })).status).toBe(200);
    expect(await count('cash_forecast_items', a.homeCompanyId)).toBe(0);
    const rows = await audit(a.homeCompanyId, 'cash_forecast_item');
    expect(rows.map((r) => r.action)).toEqual(['create', 'update', 'delete']);
    expect((await items.call(a, 'DELETE', undefined, { id: itemId })).status).toBe(404);
  });
});

describe('overrides', () => {
  it('the first save of a cell creates it (created: true) with a create audit row', async () => {
    const out = await overrides.call(a, 'PUT', OVR);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.data).toMatchObject({ created: true, override: { ...OVR, note: null } });
    overrideId = String((out.body.data!.override as { id: string }).id);
    expect((await audit(a.homeCompanyId, 'cash_forecast_override')).map((r) => r.action)).toEqual(['create']);
  });

  it('a second save of the same cell upserts (same id, created: false) and audits old -> new', async () => {
    const out = await overrides.call(a, 'PUT', { ...OVR, mode: 'move_to', amount: null, targetWeekStart: wk(2), note: 'late' });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.data).toMatchObject({ created: false, override: { id: overrideId, mode: 'move_to', amount: null, targetWeekStart: wk(2) } });
    expect(await count('cash_forecast_overrides', a.homeCompanyId)).toBe(1);
    const rows = await audit(a.homeCompanyId, 'cash_forecast_override');
    expect(rows[1].action).toBe('update');
    expect(rows[1].changes.fields).toEqual(expect.arrayContaining([
      { field: 'mode', label: 'Mode', old: 'set', new: 'move_to' },
      { field: 'amount', label: 'Amount', old: '80000', new: null },
    ]));
  });

  it('a Tuesday week and a move_to without a target are 400', async () => {
    expect((await overrides.call(a, 'PUT', { ...OVR, weekStart: wk(1, 1) })).status).toBe(400);
    expect((await overrides.call(a, 'PUT', { ...OVR, mode: 'move_to', amount: 5 })).status).toBe(400);
    expect(await audit(a.homeCompanyId, 'cash_forecast_override')).toHaveLength(2);
  });

  it('a viewer reads but cannot save or remove; B sees nothing and gets 404 removing it', async () => {
    expect(((await overrides.call(viewer, 'GET')).body.data!.overrides as unknown[])).toHaveLength(1);
    expect((await overrides.call(viewer, 'PUT', OVR)).status).toBe(403);
    expect((await overrides.call(viewer, 'DELETE', undefined, { id: overrideId })).status).toBe(403);
    expect((await overrides.call(b, 'GET')).body.data!.overrides).toEqual([]);
    expect((await overrides.call(b, 'DELETE', undefined, { id: overrideId })).status).toBe(404);
    expect(await count('cash_forecast_overrides', a.homeCompanyId)).toBe(1);
  });

  it('the owner removes it with a delete audit row', async () => {
    expect((await overrides.call(a, 'DELETE', undefined, { id: overrideId })).status).toBe(200);
    expect(await count('cash_forecast_overrides', a.homeCompanyId)).toBe(0);
    expect((await audit(a.homeCompanyId, 'cash_forecast_override')).map((r) => r.action)).toEqual(['create', 'update', 'delete']);
  });
  it('GET lists in the order the engine applies them (applied_at, id), not by week or key', async () => {
    // Three rows whose creation order differs from week order (either way) and from key order.
    for (const [lineKey, weekStart] of [['m:o', wk(2)], ['z:o', wk(0)], ['a:o', wk(1)]]) {
      expect((await overrides.call(a, 'PUT', { ...OVR, lineKey, weekStart })).status).toBe(200);
    }
    const listed = (await overrides.call(a, 'GET')).body.data!.overrides as Array<{ lineKey: string }>;
    expect(listed.map((o) => o.lineKey)).toEqual(['m:o', 'z:o', 'a:o']);
  });
});

describe('pay day', () => {
  it('defaults to day 25 with no row', async () => {
    const out = await payDay.call(viewer, 'GET');
    expect(out.status).toBe(200);
    expect(out.body.data).toEqual({ payDay: { kind: 'day_of_month', day: 25 }, day: 25, isDefault: true });
  });

  it('the owner sets day 28, then last working day (the day is kept); each audited', async () => {
    expect((await payDay.call(a, 'PUT', { kind: 'day_of_month', day: 28 })).body.data).toEqual(
      { payDay: { kind: 'day_of_month', day: 28 }, day: 28, isDefault: false });
    expect((await payDay.call(a, 'PUT', { kind: 'last_working_day' })).body.data).toEqual(
      { payDay: { kind: 'last_working_day' }, day: 28, isDefault: false });
    const rows = await audit(a.homeCompanyId, 'payroll_company_settings');
    expect(rows.map((r) => [r.action, r.user_id, r.changes.fields[0].old, r.changes.fields[0].new])).toEqual([
      ['create', a.userId, 'Not chosen (day 25)', 'Day 28'], ['update', a.userId, 'Day 28', 'Last working day']]);
    expect((await payDay.call(b, 'GET')).body.data).toMatchObject({ isDefault: true });
  });

  it('a viewer cannot set it; day 32 is a 400', async () => {
    expect((await payDay.call(viewer, 'PUT', { kind: 'day_of_month', day: 1 })).status).toBe(403);
    expect((await payDay.call(a, 'PUT', { kind: 'day_of_month', day: 32 })).status).toBe(400);
    expect(await audit(a.homeCompanyId, 'payroll_company_settings')).toHaveLength(2);
  });
});
