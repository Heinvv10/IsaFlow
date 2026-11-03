/**
 * Budgets P5-4 routes, called as real members through withAuth's request transaction (CSRF, RLS):
 *   POST /api/accounting/budgets/alerts/evaluate  owner/admin (manager, viewer 403); announces new
 *        crossings and records "last evaluated" (manual);
 *   GET  /api/accounting/budgets/alerts           owner/admin;
 *   GET  /api/accounting/budgets/controls         write roles (viewer 403);
 *   PUT  /api/accounting/budgets/controls         owner/admin (manager 403); zod bounds; the email
 *        flag refused (409) while the server switch is off; one audit row;
 *   POST/DELETE /api/accounting/budgets/controls/thresholds  owner/admin; expense accounts of the
 *        company only.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import evaluateRoute from '../../pages/api/accounting/budgets/alerts/evaluate';
import alertsRoute from '../../pages/api/accounting/budgets/alerts/index';
import controlsRoute from '../../pages/api/accounting/budgets/controls/index';
import thresholdsRoute from '../../pages/api/accounting/budgets/controls/thresholds';
import { todayInSast } from '@/lib/saDateParser';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import { journal } from './helpers/budgetAlertsFixture';
import { signSession } from './r-032-fake-gotrue.helpers';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const evaluate = budgetsRouteFixture(pool, evaluateRoute, '/api/accounting/budgets/alerts/evaluate');
const alerts = budgetsRouteFixture(pool, alertsRoute, '/api/accounting/budgets/alerts');
const controls = budgetsRouteFixture(pool, controlsRoute, '/api/accounting/budgets/controls');
const thresholds = budgetsRouteFixture(pool, thresholdsRoute, '/api/accounting/budgets/controls/thresholds');

const members: string[] = [];
async function member(companyId: string, role: string): Promise<SetupUser> {
  const userId = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed) VALUES ($1, $2, 'admin', true, true)`, [userId, `${userId}@test.local`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, $3, true)`, [companyId, userId, role]);
  members.push(userId);
  return { userId, homeCompanyId: companyId, token: await signSession(userId, undefined, 'aal2') };
}

let o: Awaited<ReturnType<typeof controls.owner>>;
let other: Awaited<ReturnType<typeof controls.owner>>;
let admin: SetupUser, manager: SetupUser, viewer: SetupUser;
let revenue: string, bank: string;

beforeAll(async () => {
  o = await controls.owner();
  other = await controls.owner();
  const co = o.u.homeCompanyId;
  // R100 a month on the expense account; R105 spent this month (SAST) → 80% and 100% cross.
  await controls.seedPrimary(o.u, o.account, o.label, o.months.map((month) => ({ month, amount: 100 })));
  revenue = String((await pool.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
                                      VALUES ($1, 'BR-4000', 'Sales', 'revenue', 'credit', 3, true) RETURNING id`, [co])).rows[0].id);
  bank = String((await pool.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
                                   VALUES ($1, 'BR-1000', 'Bank', 'asset', 'debit', 3, true) RETURNING id`, [co])).rows[0].id);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await journal(c, co, `${todayInSast().slice(0, 7)}-01`, o.u.userId, [[o.account, 105, 0], [bank, 0, 105]]);
    await c.query('COMMIT');
  } finally { c.release(); }
  admin = await member(co, 'admin');
  manager = await member(co, 'manager');
  viewer = await member(co, 'viewer');
  delete process.env.BUDGET_ALERT_EMAIL_ENABLED;
}, 60000);
afterAll(async () => {
  try {
    for (const co of [o.u.homeCompanyId, other.u.homeCompanyId]) {
      for (const t of ['user_notifications', 'budget_alerts', 'budget_alert_thresholds', 'budget_control_settings', 'accounting_settings', 'audit_log']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [co]);
      }
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [co]);
    }
    await controls.cleanup();
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1)', [members]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [members]);
  } finally {
    await pool.end();
  }
}, 60000);

type Body = { data?: Record<string, unknown>; error?: { message?: string } };
const d = (r: { body: Body }) => r.body.data as Record<string, unknown>;

describe('Evaluate now and the alert list', () => {
  it('a manager or viewer is refused; the owner evaluates (new crossings announced); a rerun by the admin fires nothing', async () => {
    expect((await evaluate.call(manager, 'POST', {})).status).toBe(403);
    expect((await evaluate.call(viewer, 'POST', {})).status).toBe(403);
    expect(await pool.query('SELECT 1 FROM budget_alerts WHERE company_id = $1', [o.u.homeCompanyId]).then((r) => r.rowCount)).toBe(0);

    const first = await evaluate.call(o.u, 'POST', {});
    expect(first.status).toBe(200);
    expect(d(first)).toMatchObject({ fiscalYear: o.label, fired: 2, resolved: 0, lastEvaluated: { source: 'manual', fired: 2 } });
    const again = await evaluate.call(admin, 'POST', {});
    expect(again.status).toBe(200);
    expect(d(again)).toMatchObject({ fired: 0, lastEvaluated: { source: 'manual', fired: 0 } });
    const n = await pool.query(`SELECT user_id FROM user_notifications WHERE company_id = $1 ORDER BY user_id`, [o.u.homeCompanyId]);
    // 80 and 100 crossed together: each owner/admin is told once (the 100).
    expect(n.rows.map((r) => r.user_id)).toEqual([admin.userId, o.u.userId].sort());
  });

  it('the list: owner/admin only; open alerts with their figures and the last evaluation', async () => {
    expect((await alerts.call(manager, 'GET')).status).toBe(403);
    const r = await alerts.call(admin, 'GET');
    expect(r.status).toBe(200);
    const list = d(r) as { open: Array<Record<string, unknown>>; resolved: unknown[]; lastEvaluated: { source: string } };
    expect(list.open.map((a) => [a.accountCode, a.threshold, a.budget, a.actual, a.pct])).toEqual([['BR-5000', 100, 100, 105, 105], ['BR-5000', 80, 100, 105, 105]]);
    expect(list.resolved).toEqual([]);
    expect(list.lastEvaluated.source).toBe('manual');
    // Another company sees none of them.
    expect((d(await alerts.call(other.u, 'GET')) as { open: unknown[] }).open).toEqual([]);
  });
});

describe('controls settings', () => {
  it('GET: write roles read the defaults; a viewer is refused', async () => {
    expect((await controls.call(viewer, 'GET')).status).toBe(403);
    const r = await controls.call(manager, 'GET');
    expect(r.status).toBe(200);
    expect(d(r)).toMatchObject({
      settings: { checkPolicy: 'warn', alertEmailEnabled: false, defaultThresholds: [80, 100, 120], updatedAt: null },
      overrides: [], emailAllowedOnServer: false,
    });
  });

  it('PUT: a manager is refused; the admin saves (thresholds sorted, duplicates dropped) with one audit row; out-of-bounds bodies are 422 (zod)', async () => {
    expect((await controls.call(manager, 'PUT', { checkPolicy: 'block' })).status).toBe(403);
    const saved = await controls.call(admin, 'PUT', { checkPolicy: 'block', defaultThresholds: [120, 80, 100, 80] });
    expect(saved.status).toBe(200);
    expect(d(saved)).toMatchObject({ settings: { checkPolicy: 'block', alertEmailEnabled: false, defaultThresholds: [80, 100, 120] } });
    const audit = await pool.query(`SELECT changes FROM audit_log WHERE company_id = $1 AND entity_type = 'budget' AND entity_ref = 'Budget controls'`, [o.u.homeCompanyId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].changes.fields.map((x: { field: string }) => x.field)).toEqual(['checkPolicy']);
    for (const bad of [{ defaultThresholds: [0] }, { defaultThresholds: [1000] }, { defaultThresholds: [1, 2, 3, 4, 5, 6] }, { defaultThresholds: [] },
      { defaultThresholds: [50.5] }, { checkPolicy: 'strict' }, {}, { other: 1 }]) {
      expect((await controls.call(o.u, 'PUT', bad)).status, JSON.stringify(bad)).toBe(422);
    }
  });

  it('the email flag cannot be switched on while the server switch is off (409); off is always allowed', async () => {
    const r = await controls.call(o.u, 'PUT', { alertEmailEnabled: true });
    expect(r.status).toBe(409);
    expect(r.body.error?.message).toMatch(/switched off on this server/);
    expect((await controls.call(o.u, 'PUT', { alertEmailEnabled: false })).status).toBe(200);
    const row = await pool.query('SELECT alert_email_enabled FROM budget_control_settings WHERE company_id = $1', [o.u.homeCompanyId]);
    expect(row.rows[0].alert_email_enabled).toBe(false);
  });
});

describe('threshold overrides', () => {
  it('owner/admin create, replace and delete; a manager is refused; revenue or another company\'s account is 400', async () => {
    expect((await thresholds.call(manager, 'POST', { glAccountId: o.account, thresholds: [90] })).status).toBe(403);
    expect((await thresholds.call(o.u, 'POST', { glAccountId: revenue, thresholds: [90] })).status).toBe(400);
    expect((await thresholds.call(o.u, 'POST', { glAccountId: other.account, thresholds: [90] })).status).toBe(400);
    const made = await thresholds.call(o.u, 'POST', { glAccountId: o.account, thresholds: [95, 60] });
    expect(made.status).toBe(200);
    const ov = (d(made) as { override: { id: string; thresholds: number[]; accountCode: string; sliceName: null } }).override;
    expect(ov).toMatchObject({ thresholds: [60, 95], accountCode: 'BR-5000', sliceName: null });
    const replaced = await thresholds.call(admin, 'POST', { glAccountId: o.account, thresholds: [70] });
    expect((d(replaced) as { override: { id: string; thresholds: number[] } }).override).toMatchObject({ id: ov.id, thresholds: [70] });
    expect((d(await controls.call(manager, 'GET')) as { overrides: unknown[] }).overrides).toHaveLength(1);
    expect((await thresholds.call(manager, 'DELETE', { id: ov.id })).status).toBe(403);
    expect((await thresholds.call(other.u, 'DELETE', { id: ov.id })).status).toBe(404);
    expect((await thresholds.call(o.u, 'DELETE', { id: ov.id })).status).toBe(200);
    expect((await thresholds.call(o.u, 'DELETE', { id: ov.id })).status).toBe(404);
  });
});
