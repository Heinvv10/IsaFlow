/**
 * POST/DELETE /api/accounting/sars/compliance-filed and the GET calendar that shows the mark, called
 * as real members through withAuth's request transaction (app_user, RLS, CSRF):
 *   - a write role marks an item filed (201), the calendar shows it completed with who, when and the
 *     reference, and one audit row records it; a second mark is 409; an undo is 200 with its own
 *     audit row; an undo of nothing is 404; an item not on the calendar is 404;
 *   - a viewer is refused (403); company B neither sees A's mark nor can undo it.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import filedRoute from '../../pages/api/accounting/sars/compliance-filed';
import calendarRoute from '../../pages/api/accounting/sars/sars-compliance';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import { signSession } from './r-032-fake-gotrue.helpers';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { als } from '@/lib/als';
import { getComplianceCalendarWithMarks } from '@/modules/accounting/services/reports/sarsComplianceCalendarDb';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const filed = budgetsRouteFixture(pool, filedRoute, '/api/accounting/sars/compliance-filed');
const calendar = budgetsRouteFixture(pool, calendarRoute, '/api/accounting/sars/sars-compliance');

const Y = new Date().getFullYear();
const FEB_END = `${Y}-02-${new Date(Date.UTC(Y, 2, 0)).getUTCDate()}`;
const KEY = { eventType: 'EMP201_DUE', periodEnd: FEB_END };

const members: string[] = [];
let a: SetupUser, b: SetupUser, viewer: SetupUser;

async function member(companyId: string, role: string): Promise<SetupUser> {
  const userId = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed, first_name, last_name)
                    VALUES ($1, $2, 'admin', true, true, 'Vee', 'Ewer')`, [userId, `${userId}@test.local`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, $3, true)`, [companyId, userId, role]);
  members.push(userId);
  return { userId, homeCompanyId: companyId, token: await signSession(userId, undefined, 'aal2') };
}

async function febEmp201(u: SetupUser): Promise<Record<string, unknown> | undefined> {
  const out = await calendar.call(u, 'GET');
  expect(out.status).toBe(200);
  expect(out.body.data?.marksUnavailable).toBe(false);
  const events = (out.body.data?.events ?? []) as Array<Record<string, unknown>>;
  return events.find((e) => e.eventType === 'EMP201_DUE' && e.periodEnd === FEB_END);
}

const auditRows = async (co: string) => (await pool.query(
  `SELECT action, user_id, entity_type, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'sars_compliance_event' ORDER BY created_at, action`,
  [co])).rows;

beforeAll(async () => {
  a = (await filed.owner()).u;
  b = (await filed.owner()).u;
  viewer = await member(a.homeCompanyId, 'viewer');
}, 60_000);
afterAll(async () => {
  try {
    for (const co of [a.homeCompanyId, b.homeCompanyId]) {
      await pool.query('DELETE FROM sars_compliance_events WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM audit_log WHERE company_id = $1', [co]);
    }
    await filed.cleanup();
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1)', [members]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [members]);
  } finally { await pool.end(); }
});

describe('mark filed, then undo', () => {
  it('the item starts unmarked', async () => {
    const e = await febEmp201(a);
    expect(e).toBeDefined();
    expect(e!.id).toBeUndefined();
    expect(e!.status).not.toBe('completed');
  });

  it('a viewer cannot mark', async () => {
    expect((await filed.call(viewer, 'POST', KEY)).status).toBe(403);
  });

  it('the owner marks it filed (201); the calendar shows completed, who, when, the reference', async () => {
    const out = await filed.call(a, 'POST', { ...KEY, sarsReference: '  EF-123  ' });
    expect(out.status).toBe(201);
    expect(out.body.data).toMatchObject({ sarsReference: 'EF-123' });
    const e = await febEmp201(a);
    expect(e).toMatchObject({ status: 'completed', sarsReference: 'EF-123' });
    expect(typeof e!.filedAt).toBe('string');
    expect(e!.filedBy).toBeTruthy();
    const row = (await pool.query('SELECT filed_by FROM sars_compliance_events WHERE company_id = $1', [a.homeCompanyId])).rows;
    expect(row).toEqual([{ filed_by: a.userId }]);
  });

  it('one audit row records the mark, by the owner, with the period and reference', async () => {
    const rows = await auditRows(a.homeCompanyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'create', user_id: a.userId });
    expect(rows[0].changes.metadata).toMatchObject({ area: 'sars_filed', eventType: 'EMP201_DUE', periodEnd: FEB_END, sarsReference: 'EF-123' });
  });

  it('a second mark of the period is 409 and writes nothing', async () => {
    const out = await filed.call(a, 'POST', KEY);
    expect(out.status).toBe(409);
    expect(await auditRows(a.homeCompanyId)).toHaveLength(1);
  });

  it("company B does not see A's mark and cannot undo it", async () => {
    const e = await febEmp201(b);
    expect(e!.id).toBeUndefined();
    expect((await filed.call(b, 'DELETE', KEY)).status).toBe(404);
    expect((await pool.query('SELECT COUNT(*)::int n FROM sars_compliance_events WHERE company_id = $1', [a.homeCompanyId])).rows[0].n).toBe(1);
  });

  it('a viewer cannot undo', async () => {
    expect((await filed.call(viewer, 'DELETE', KEY)).status).toBe(403);
  });

  it('the owner undoes it (200); the item is unmarked; a second audit row records the undo', async () => {
    expect((await filed.call(a, 'DELETE', KEY)).status).toBe(200);
    expect((await febEmp201(a))!.id).toBeUndefined();
    const rows = await auditRows(a.homeCompanyId);
    expect(rows.map((r) => r.action).sort()).toEqual(['create', 'delete']);
    expect(rows.find((r) => r.action === 'delete')!.changes.metadata).toMatchObject({ periodEnd: FEB_END, sarsReference: 'EF-123' });
  });

  it('an undo of nothing is 404', async () => {
    expect((await filed.call(a, 'DELETE', KEY)).status).toBe(404);
  });
});

describe('refusals', () => {
  it('a POST without the CSRF header is refused and writes nothing', async () => {
    const req = request({ 'sb-access-token': a.token, active_company_id: a.homeCompanyId }, 'POST') as unknown as
      { url: string; query: Record<string, string>; body: unknown; headers: Record<string, string> };
    delete req.headers['x-csrf-token'];
    req.url = '/api/accounting/sars/compliance-filed';
    req.query = {};
    req.body = KEY;
    const out = response();
    await (filedRoute as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
    expect(out.state.statusCode).toBe(403);
    expect((await pool.query('SELECT COUNT(*)::int n FROM sars_compliance_events WHERE company_id = $1', [a.homeCompanyId])).rows[0].n).toBe(0);
  });

  it('an item not on the calendar is 404', async () => {
    expect((await filed.call(a, 'POST', { eventType: 'EMP201_DUE', periodEnd: `${Y}-02-15` })).status).toBe(404);
  });
  it('an unknown type or a bad date is 400', async () => {
    expect((await filed.call(a, 'POST', { eventType: 'ITR14', periodEnd: FEB_END })).status).toBe(400);
    expect((await filed.call(a, 'POST', { eventType: 'EMP201_DUE', periodEnd: `${Y}-02-31` })).status).toBe(400);
    expect((await filed.call(a, 'POST', { ...KEY, sarsReference: 'x'.repeat(101) })).status).toBe(400);
  });
});

describe('a failed marks read leaves the request transaction usable', () => {
  it('permission denied on the marks read: static calendar, and the next statement in the tx still runs', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Rolled back with the transaction: app_user loses SELECT only inside this test's tx (prod's app_service case).
      await client.query('REVOKE SELECT ON sars_compliance_events FROM app_user');
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a.userId })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [a.homeCompanyId]);
      const out = await als.run({ client, userId: a.userId, companyId: a.homeCompanyId, claims: { sub: a.userId } } as never,
        () => getComplianceCalendarWithMarks(a.homeCompanyId, Y));
      expect(out.events.length).toBeGreaterThan(10);
      expect(out.marksUnavailable).toBe(true);
      expect((await client.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
