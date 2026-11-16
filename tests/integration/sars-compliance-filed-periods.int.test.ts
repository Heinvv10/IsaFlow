/**
 * "Marked filed" across the return types and the period rules, through the real routes (withAuth,
 * app_user, RLS, CSRF):
 *   - VAT201, IRP6 and a December EMP201 (due in January of the next year) mark and show completed;
 *   - an IRP6 mark never marks the EMP501 that ends the same day;
 *   - a VAT mark made under one cadence does not mark the other cadence's period ending the same
 *     day, which can be marked on its own, and shows again when the cadence returns;
 *   - a pre-999c row (no period) shows as a mark and Undo removes it;
 *   - a period end outside the year before to the year after this one is 404.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import filedRoute from '../../pages/api/accounting/sars/compliance-filed';
import calendarRoute from '../../pages/api/accounting/sars/sars-compliance';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const filed = budgetsRouteFixture(pool, filedRoute, '/api/accounting/sars/compliance-filed');
const calendar = budgetsRouteFixture(pool, calendarRoute, '/api/accounting/sars/sars-compliance');
const Y = new Date().getFullYear();
let o: SetupUser;

type Ev = Record<string, unknown>;
async function events(): Promise<Ev[]> {
  const out = await calendar.call(o, 'GET');
  expect(out.status).toBe(200);
  return (out.body.data?.events ?? []) as Ev[];
}
const item = async (type: string, periodEnd: string) => (await events()).find((e) => e.eventType === type && e.periodEnd === periodEnd);
const setCadence = (cadence: 'bi-monthly' | 'monthly') => pool.query(
  `UPDATE companies SET vat_period = $2, vat_period_alignment = 'odd', vat_system_type = 'invoice' WHERE id = $1`, [o.homeCompanyId, cadence]);

beforeAll(async () => {
  o = (await filed.owner()).u;
  await setCadence('bi-monthly');
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM sars_compliance_events WHERE company_id = $1', [o.homeCompanyId]);
    await pool.query('DELETE FROM audit_log WHERE company_id = $1', [o.homeCompanyId]);
    await filed.cleanup();
  } finally { await pool.end(); }
});

describe('each return type marks and shows', () => {
  it('VAT201 (Cat A Feb–Mar)', async () => {
    expect((await filed.call(o, 'POST', { eventType: 'VAT201_DUE', periodEnd: `${Y}-03-31` })).status).toBe(201);
    expect(await item('VAT201_DUE', `${Y}-03-31`)).toMatchObject({ status: 'completed', periodStart: `${Y}-02-01` });
  });

  it('IRP6 first payment, and the EMP501 interim ending the same day stays unmarked', async () => {
    expect((await filed.call(o, 'POST', { eventType: 'PROVISIONAL_TAX', periodEnd: `${Y}-08-31` })).status).toBe(201);
    expect((await item('PROVISIONAL_TAX', `${Y}-08-31`))?.status).toBe('completed');
    expect((await item('EMP501_DUE', `${Y}-08-31`))?.id).toBeUndefined();
  });

  it('a December EMP201, due in January of the next year', async () => {
    expect((await filed.call(o, 'POST', { eventType: 'EMP201_DUE', periodEnd: `${Y}-12-31` })).status).toBe(201);
    const dec = await item('EMP201_DUE', `${Y}-12-31`);
    expect(String(dec?.dueDate).slice(0, 4)).toBe(String(Y + 1));
    expect(dec?.status).toBe('completed');
  });
});

describe('a cadence change', () => {
  it('a bi-monthly mark does not mark the monthly period ending the same day', async () => {
    await setCadence('monthly');
    const mar = await item('VAT201_DUE', `${Y}-03-31`);
    expect(mar?.periodStart).toBe(`${Y}-03-01`);
    expect(mar?.id).toBeUndefined();
  });

  it('the monthly period can be marked on its own (201, not 409)', async () => {
    expect((await filed.call(o, 'POST', { eventType: 'VAT201_DUE', periodEnd: `${Y}-03-31` })).status).toBe(201);
    expect((await item('VAT201_DUE', `${Y}-03-31`))?.status).toBe('completed');
  });

  it('back on bi-monthly, the bi-monthly mark shows again', async () => {
    await setCadence('bi-monthly');
    expect(await item('VAT201_DUE', `${Y}-03-31`)).toMatchObject({ status: 'completed', periodStart: `${Y}-02-01` });
  });
});

describe('a pre-999c row (no period)', () => {
  it('shows as the mark, and Undo removes it (200, one audit row)', async () => {
    const mar = await item('EMP201_DUE', `${Y}-03-31`);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: o.userId })]);
      await c.query(`INSERT INTO sars_compliance_events (company_id, event_type, due_date, description, status)
                     VALUES ($1, 'EMP201_DUE', $2, 'legacy', 'completed')`, [o.homeCompanyId, mar!.dueDate]);
      await c.query('COMMIT');
    } finally { c.release(); }
    expect((await item('EMP201_DUE', `${Y}-03-31`))?.status).toBe('completed');
    expect((await filed.call(o, 'DELETE', { eventType: 'EMP201_DUE', periodEnd: `${Y}-03-31` })).status).toBe(200);
    expect((await item('EMP201_DUE', `${Y}-03-31`))?.id).toBeUndefined();
    const audit = (await pool.query(
      `SELECT COUNT(*)::int n FROM audit_log WHERE company_id = $1 AND entity_type = 'sars_compliance_event' AND action = 'delete'`,
      [o.homeCompanyId])).rows[0].n;
    expect(audit).toBe(1);
  });
});

describe('the year window', () => {
  it.each([[Y + 2], [Y - 2]])('a period end in %i is 404 and writes nothing', async (year) => {
    const before = (await pool.query('SELECT COUNT(*)::int n FROM sars_compliance_events WHERE company_id = $1', [o.homeCompanyId])).rows[0].n;
    expect((await filed.call(o, 'POST', { eventType: 'EMP201_DUE', periodEnd: `${year}-01-31` })).status).toBe(404);
    expect((await pool.query('SELECT COUNT(*)::int n FROM sars_compliance_events WHERE company_id = $1', [o.homeCompanyId])).rows[0].n).toBe(before);
  });
});
