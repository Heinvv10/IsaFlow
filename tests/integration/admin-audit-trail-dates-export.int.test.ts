/**
 * Admin Audit Trail (audit 4.12, 3.8).
 *
 * 4.12: the From/To dates are whole SAST days. `to_date` was cast to midnight
 * (`created_at <= '2026-11-14'::timestamptz`), so the page's default range (month
 * start to today) hid every entry made today; `from_date` was midnight UTC, two
 * hours into the SAST day. The cluster runs in UTC, as dev and production do.
 *
 * 3.8: Export CSV exports every matching entry, not the page of 50 on screen, and
 * leaves an audit row with the filters and the count.
 *
 * Disposable schema fixture only (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getUnifiedAuditLog } from '@/modules/admin/services/auditQueryService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { auditRows, callAdminRoute, csvDataLines, seedSuperAdmin } from './admin-audited-exports.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const admin = crypto.randomUUID();
const actor = crypto.randomUUID();
const ACTION = `wp10probe${Date.now()}`;

// One SAST day, 2026-11-10, and its neighbours. SAST is UTC+2 all year.
const at = async (utc: string, marker: string, targetType = 'probe') => pool.query(
  `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, created_at)
   VALUES ($1, $2, $5, $3, $4::timestamptz)`, [actor, ACTION, marker, utc, targetType]);

beforeAll(async () => {
  await seedSuperAdmin(pool, admin);
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [actor, `${actor}@test.local`]);
  await at('2026-11-09T21:59:00Z', 'before-day');    // 23:59 SAST on the 9th
  await at('2026-11-09T22:00:00Z', 'day-first');     // 00:00 SAST on the 10th, exactly: From is inclusive
  await at('2026-11-09T22:30:00Z', 'day-start');     // 00:30 SAST on the 10th
  await at('2026-11-10T12:00:00Z', 'day-mid');       // 14:00 SAST
  await at('2026-11-10T21:30:00Z', 'day-end');       // 23:30 SAST
  await at('2026-11-10T22:00:00Z', 'after-day');     // 00:00 SAST on the 11th, exactly: To is exclusive of the next day
}, 60000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = ANY($1)', [[admin, actor]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, actor]]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally {
    await pool.end();
  }
}, 60000);

describe('audit trail From/To are whole SAST days (4.12)', () => {
  it('From = To = one day returns exactly that SAST day', async () => {
    const r = await getUnifiedAuditLog({
      source: 'admin', action: ACTION, from_date: '2026-11-10', to_date: '2026-11-10', limit: 100,
    });
    expect(r.items.map((i) => i.entity_id).sort()).toEqual(['day-end', 'day-first', 'day-mid', 'day-start']);
    expect(r.total).toBe(4);
  }, 30000);
});

describe('audit export (3.8)', () => {
  it('exports every matching entry beyond one page and audits the filters and count', async () => {
    for (let i = 0; i < 120; i++) await at('2026-11-12T08:00:00Z', `bulk-${i}`);
    const { default: exportRoute } = await import('../../pages/api/admin/audit/export');
    const query = { source: 'admin', action: ACTION, from_date: '2026-11-12', to_date: '2026-11-12' };
    const r = await callAdminRoute(admin, exportRoute, 'GET', '/api/admin/audit/export', query);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(csvDataLines(r.text)).toHaveLength(120);
    const rows = await auditRows(pool, admin, 'audit.export');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toEqual({
      export: 'audit', row_count: 120,
      filters: { source: 'admin', company_id: null, action: ACTION, entity_type: null, search: false,
        from_date: '2026-11-12', to_date: '2026-11-12' },
    });
  }, 60000);

  it('neutralises a formula cell', async () => {
    await at('2026-11-13T08:00:00Z', 'formula', '=cmd|calc');
    const { default: exportRoute } = await import('../../pages/api/admin/audit/export');
    const r = await callAdminRoute(admin, exportRoute, 'GET', '/api/admin/audit/export',
      { source: 'admin', action: ACTION, from_date: '2026-11-13', to_date: '2026-11-13' });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const lines = csvDataLines(r.text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"'=cmd|calc"`);
  }, 60000);

  it('answers 405 to a non-GET and 400 to a bad source, company_id or date, auditing nothing', async () => {
    const { default: exportRoute } = await import('../../pages/api/admin/audit/export');
    const call = (method: string, query: Record<string, string>) =>
      callAdminRoute(admin, exportRoute, method, '/api/admin/audit/export', query);
    expect((await call('POST', {})).status).toBe(405);
    expect((await call('GET', { source: 'everything' })).status).toBe(400);
    expect((await call('GET', { company_id: 'not-a-uuid' })).status).toBe(400);
    expect((await call('GET', { from_date: '2026-02-31' })).status).toBe(400);
    expect((await call('GET', { to_date: '14/11/2026' })).status).toBe(400);
    expect(await auditRows(pool, admin, 'audit.export')).toHaveLength(2); // the two exports above, nothing more
  }, 60000);

  it('more than 100,000 matching entries is refused (400) and audits nothing', async () => {
    const big = `${ACTION}big`;
    await pool.query(`INSERT INTO admin_audit_log (admin_user_id, action, target_type, created_at)
      SELECT $1, $2, 'probe', '2026-11-14T08:00:00Z'::timestamptz FROM generate_series(1, 100001)`, [actor, big]);
    try {
      const { default: exportRoute } = await import('../../pages/api/admin/audit/export');
      const r = await callAdminRoute(admin, exportRoute, 'GET', '/api/admin/audit/export',
        { source: 'admin', action: big, from_date: '2026-11-14', to_date: '2026-11-14' });
      expect(r.status, r.text.slice(0, 200)).toBe(400);
      expect(r.json?.error?.message).toMatch(/^100.001 entries match; narrow the dates to export at most 100.000$/);
      expect(await auditRows(pool, admin, 'audit.export')).toHaveLength(2);
    } finally {
      await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1 AND action = $2', [actor, big]);
    }
  }, 120000);
});
