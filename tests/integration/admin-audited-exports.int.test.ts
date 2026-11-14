/**
 * Admin CSV exports (audit 3.5, 3.8): each of the four exports — users (PII),
 * companies, subscriptions, web analytics — writes an admin audit row naming who,
 * which export, the filters and the row count (never the data), honours the
 * filters the page shows, returns every matching row, and neutralises formula
 * cells. A failed audit write means no CSV: the export answers 500.
 *
 * Disposable schema fixture only (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import usersExport from '../../pages/api/admin/users/export';
import companiesExport from '../../pages/api/admin/companies/export';
import subscriptionsExport from '../../pages/api/admin/billing/subscriptions/export';
import webExport from '../../pages/api/admin/analytics/web/export';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { auditRows, callAdminRoute, csvDataLines, seedSuperAdmin } from './admin-audited-exports.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const admin = crypto.randomUUID();
const TAG = `wp10x${Date.now()}`;
const alpha = crypto.randomUUID();
const beta = crypto.randomUUID();
const formulaCo = crypto.randomUUID();
const planId = crypto.randomUUID();
const website = crypto.randomUUID();
const humans: string[] = [];
let bob = '';

beforeAll(async () => {
  await seedSuperAdmin(pool, admin);
  await pool.query(`INSERT INTO companies (id, name, status, created_at) VALUES
    ($1, $4, 'active', NOW() - INTERVAL '3 days'),
    ($2, $5, 'suspended', NOW() - INTERVAL '2 days'),
    ($3, $6, 'active', NOW() - INTERVAL '1 day')`,
    [alpha, beta, formulaCo, `${TAG} Alpha`, `${TAG} Beta`, `=${TAG} formula`]);
  // 30 users in Alpha: more than one page of the Users list (25).
  for (let i = 0; i < 30; i++) {
    const id = crypto.randomUUID();
    humans.push(id);
    await pool.query(`INSERT INTO users (id, email, first_name, role, is_active) VALUES ($1, $2, $3, 'viewer', true)`,
      [id, `${TAG}-a${i}@test.local`, i === 0 ? `=cmd|' /C calc'!A0` : `A${i}`]);
    await pool.query(`INSERT INTO company_users (user_id, company_id, role) VALUES ($1, $2, 'viewer')`, [id, alpha]);
  }
  bob = crypto.randomUUID();
  humans.push(bob);
  await pool.query(`INSERT INTO users (id, email, first_name, role, is_active) VALUES ($1, $2, 'Bob', 'viewer', false)`,
    [bob, `${TAG}-bob@test.local`]);
  await pool.query(`INSERT INTO company_users (user_id, company_id, role) VALUES ($1, $2, 'viewer')`, [bob, beta]);

  await pool.query(`INSERT INTO plans (id, code, name, monthly_price_cents, annual_price_cents) VALUES ($1, $2, $3, 10000, 100000)`,
    [planId, `${TAG}-plan`, `${TAG} Plan`]);
  await pool.query(`INSERT INTO subscriptions (company_id, plan_id, status, billing_cycle, created_at) VALUES
    ($1, $3, 'active', 'monthly', NOW() - INTERVAL '2 days'), ($2, $3, 'cancelled', 'monthly', NOW() - INTERVAL '1 day')`,
    [alpha, beta, planId]);

  await pool.query(`INSERT INTO analytics_websites (id, name, tracking_id, category) VALUES ($1, $2, $3, 'marketing')`,
    [website, `${TAG} site`, `${TAG}-trk`]);
  const human = crypto.randomUUID();
  const crawler = crypto.randomUUID();
  await pool.query(`INSERT INTO analytics_sessions (id, website_id, session_hash, visitor_hash, utm_campaign, is_bot, first_seen, last_seen)
    VALUES ($1, $3, 'h1', 'v1', '=HYPERLINK("http://evil.invalid","x")', false, NOW(), NOW()),
           ($2, $3, 'h2', 'v2', NULL, true, NOW(), NOW())`, [human, crawler, website]);
  await pool.query(`INSERT INTO analytics_events (website_id, session_id, event_type, url_path, page_title, created_at)
    VALUES ($1, $2, 'pageview', '/', '+SUM(A1)', NOW()), ($1, $3, 'pageview', '/robots', 'bot', NOW())`,
    [website, human, crawler]);
}, 60000);

afterAll(async () => {
  try {
    await pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS wp10_block_export_audit`);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM analytics_events WHERE website_id = $1', [website]);
    await pool.query('DELETE FROM analytics_sessions WHERE website_id = $1', [website]);
    await pool.query('DELETE FROM analytics_websites WHERE id = $1', [website]);
    await pool.query('DELETE FROM subscriptions WHERE plan_id = $1', [planId]);
    await pool.query('DELETE FROM plans WHERE id = $1', [planId]);
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1)', [humans]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[...humans, admin]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[alpha, beta, formulaCo]]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally {
    await pool.end();
  }
}, 60000);

describe('users export (PII)', () => {
  it('honours search, company and status, returns every page, neutralises formulas, audits who/filters/count', async () => {
    const r = await callAdminRoute(admin, usersExport, 'GET', '/api/admin/users/export',
      { search: TAG, company: `${TAG} Alpha`, status: 'active' });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const lines = csvDataLines(r.text);
    expect(lines).toHaveLength(30);
    expect(lines.some((l) => l.includes('-bob@'))).toBe(false);
    expect(r.text).toContain(`"'=cmd|' /C calc'!A0"`);
    expect(r.text).not.toMatch(/(^|,)"=cmd/m);

    const rows = await auditRows(pool, admin, 'user.export');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_type: 'export', target_id: null });
    expect(rows[0]!.details).toEqual({
      export: 'users', row_count: 30,
      filters: { search: TAG, company: `${TAG} Alpha`, role: null, status: 'active' },
    });
    expect(JSON.stringify(rows[0]!.details)).not.toContain(humans[0]!);
  }, 30000);

  it('status=suspended lists only suspended users', async () => {
    const r = await callAdminRoute(admin, usersExport, 'GET', '/api/admin/users/export', { search: TAG, status: 'suspended' });
    expect(r.status).toBe(200);
    const lines = csvDataLines(r.text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${TAG}-bob@test.local`);
  }, 30000);
});

describe('companies export', () => {
  it('honours search, status and sort, neutralises formulas, audits filters and count', async () => {
    const r = await callAdminRoute(admin, companiesExport, 'GET', '/api/admin/companies/export',
      { search: TAG, status: 'active', sort_by: 'created_at', sort_dir: 'asc' });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const lines = csvDataLines(r.text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`"${TAG} Alpha"`);
    expect(lines[1]).toContain(`"'=${TAG} formula"`);
    const rows = await auditRows(pool, admin, 'company.export');
    expect(rows.at(-1)!.details).toEqual({
      export: 'companies', row_count: 2,
      filters: { search: TAG, status: 'active', sort_by: 'created_at', sort_dir: 'asc', from: null, to: null },
    });
  }, 30000);
});

describe('subscriptions export', () => {
  it('honours search and status, audits filters and count', async () => {
    const r = await callAdminRoute(admin, subscriptionsExport, 'GET', '/api/admin/billing/subscriptions/export',
      { search: TAG, status: 'active' });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const lines = csvDataLines(r.text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"${TAG} Alpha"`);
    const rows = await auditRows(pool, admin, 'subscription.export');
    expect(rows.at(-1)!.details).toEqual({
      export: 'subscriptions', row_count: 1, filters: { search: TAG, status: 'active', plan_id: null },
    });
  }, 30000);
});

describe('web analytics export', () => {
  it('excludes bots unless asked, neutralises formula cells, audits filters and count', async () => {
    const r = await callAdminRoute(admin, webExport, 'GET', '/api/admin/analytics/web/export', { website_id: website, range: '24h' });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const lines = csvDataLines(r.text);
    expect(lines).toHaveLength(1);
    expect(r.text).toContain(`"'+SUM(A1)"`);
    expect(r.text).toContain(`"'=HYPERLINK(""http://evil.invalid"",""x"")"`);
    expect(r.text).not.toMatch(/(^|,)"?[=+]/m);

    const withBots = await callAdminRoute(admin, webExport, 'GET', '/api/admin/analytics/web/export',
      { website_id: website, range: '24h', include_bots: '1' });
    expect(csvDataLines(withBots.text)).toHaveLength(2);

    const rows = await auditRows(pool, admin, 'web_analytics.export');
    expect(rows.map((x) => x.details)).toEqual([
      { export: 'web_analytics', row_count: 1, filters: { website_id: website, range: '24h', include_bots: false } },
      { export: 'web_analytics', row_count: 2, filters: { website_id: website, range: '24h', include_bots: true } },
    ]);
  }, 30000);
});

describe('fail closed', () => {
  it('an export whose audit row cannot be written sends no CSV (500)', async () => {
    await pool.query(`ALTER TABLE admin_audit_log ADD CONSTRAINT wp10_block_export_audit
      CHECK (action <> 'user.export' OR admin_user_id <> '${admin}') NOT VALID`);
    try {
      const r = await callAdminRoute(admin, usersExport, 'GET', '/api/admin/users/export', { search: TAG });
      expect(r.status).toBe(500);
      expect(r.text).not.toContain(`${TAG}-a1@test.local`);
    } finally {
      await pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS wp10_block_export_audit`);
    }
  }, 30000);
});
