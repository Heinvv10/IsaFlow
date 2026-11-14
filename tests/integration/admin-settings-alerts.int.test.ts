/**
 * Admin settings + alert settings through the real routes (withAdmin, withCsrf, the audit write).
 * Removed toggles (maintenance_mode, registration_enabled, max_companies_per_user) are not served
 * and not accepted; a blank alert email / webhook clears the stored value instead of being rejected.
 *
 * Disposable schema fixture only (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import settingsRoute from '../../pages/api/admin/settings';
import alertRoute from '../../pages/api/admin/alert-settings';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const admin = crypto.randomUUID();
const KEYS = ['health_alert_email', 'health_alert_webhook_url', 'maintenance_mode', 'registration_enabled', 'max_companies_per_user'];
const saved = new Map<string, unknown>();

type Route = (req: never, res: never) => Promise<unknown>;
async function call(route: Route, method: string, body?: unknown) {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, method) as unknown as { body: unknown };
  req.body = body;
  const result = response();
  await route(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as { data?: Record<string, unknown>; error?: { message?: string } } };
}
const stored = async (key: string) =>
  (await pool.query('SELECT value FROM admin_settings WHERE key = $1', [key])).rows[0]?.value as unknown;

beforeAll(async () => {
  for (const r of (await pool.query('SELECT key, value FROM admin_settings WHERE key = ANY($1)', [KEYS])).rows) saved.set(r.key as string, r.value);
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
}, 60000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM admin_settings WHERE key = ANY($1)', [KEYS]);
    for (const [key, value] of saved) {
      await pool.query('INSERT INTO admin_settings (key, value) VALUES ($1, $2::jsonb)', [key, JSON.stringify(value)]);
    }
    await pool.query('UPDATE admin_settings SET updated_by = NULL WHERE updated_by = $1', [admin]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally {
    await pool.end();
  }
}, 60000);

describe('admin platform settings', () => {
  it('GET returns only smtp_configured even when legacy rows are stored', async () => {
    await pool.query(`INSERT INTO admin_settings (key, value) VALUES ('maintenance_mode', 'true'::jsonb), ('max_companies_per_user', '9'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const r = await call(settingsRoute as Route, 'GET');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data ?? {})).toEqual(['smtp_configured']);
  }, 30000);

  it('PATCH with a removed key is refused and writes nothing', async () => {
    await pool.query(`DELETE FROM admin_settings WHERE key = 'registration_enabled'`);
    const r = await call(settingsRoute as Route, 'PATCH', { registration_enabled: false });
    expect(r.status).toBe(405);
    expect(await stored('registration_enabled')).toBeUndefined();
  }, 30000);
});

describe('admin alert settings', () => {
  it('saves a valid email and webhook, then a blank value clears each', async () => {
    const set = await call(alertRoute as Route, 'PATCH', { health_alert_email: 'ops@example.co.za', health_alert_webhook_url: 'https://hooks.example.com/x' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(await stored('health_alert_email')).toBe('ops@example.co.za');

    const clear = await call(alertRoute as Route, 'PATCH', { health_alert_email: '', health_alert_webhook_url: '   ' });
    expect(clear.status, JSON.stringify(clear.body)).toBe(200);
    expect(await stored('health_alert_email')).toBeUndefined();
    expect(await stored('health_alert_webhook_url')).toBeUndefined();

    const got = await call(alertRoute as Route, 'GET');
    expect(got.body.data).toEqual({ health_alert_email: '', health_alert_webhook_url: '' });
  }, 30000);

  it('audits each key as set / cleared / unchanged, never the value', async () => {
    await call(alertRoute as Route, 'PATCH', { health_alert_email: 'a@example.co.za', health_alert_webhook_url: '' });
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    const r = await call(alertRoute as Route, 'PATCH', { health_alert_email: '', health_alert_webhook_url: '' });
    expect(r.status).toBe(200);
    const rows = (await pool.query(`SELECT details FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'update_alert_settings'`, [admin])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toEqual({ changes: { health_alert_email: 'cleared', health_alert_webhook_url: 'unchanged' } });
    await call(alertRoute as Route, 'PATCH', { health_alert_email: 'secret@example.co.za' });
    const last = (await pool.query(`SELECT details FROM admin_audit_log WHERE admin_user_id = $1 ORDER BY created_at DESC LIMIT 1`, [admin])).rows[0];
    expect(last.details).toEqual({ changes: { health_alert_email: 'set' } });
    expect(JSON.stringify(last.details)).not.toContain('secret@');
  }, 30000);

  it('an invalid value names the field problem, not a generic "Invalid input"', async () => {
    const r = await call(alertRoute as Route, 'PATCH', { health_alert_email: 'not-an-email' });
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/email/i);
    expect(r.body.error?.message).not.toBe('Invalid input');
  }, 30000);

  it.each(['javascript:alert(1)', 'ftp://hooks.example.com/x', 'http://hooks.example.com/x'])('webhook %s is refused (https only)', async (url) => {
    await pool.query(`DELETE FROM admin_settings WHERE key = 'health_alert_webhook_url'`);
    const r = await call(alertRoute as Route, 'PATCH', { health_alert_webhook_url: url });
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/https/i);
    expect(await stored('health_alert_webhook_url')).toBeUndefined();
  }, 30000);

  it('editing only the email accepts a stored legacy http:// webhook sent back unchanged', async () => {
    await pool.query(`INSERT INTO admin_settings (key, value) VALUES ('health_alert_webhook_url', '"http://legacy.example.com/hook"'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const r = await call(alertRoute as Route, 'PATCH', { health_alert_email: 'ops2@example.co.za', health_alert_webhook_url: 'http://legacy.example.com/hook' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await stored('health_alert_webhook_url')).toBe('http://legacy.example.com/hook');
    const changed = await call(alertRoute as Route, 'PATCH', { health_alert_webhook_url: 'http://other.example.com/hook' });
    expect(changed.status).toBe(400);
  }, 30000);

  it.each([
    'https://localhost/x', 'https://app.localhost/x', 'https://127.0.0.1/x', 'https://127.1.2.3:8443/x', 'https://10.0.0.5/x',
    'https://172.16.0.1/x', 'https://172.31.255.254/x', 'https://192.168.1.10/x', 'https://169.254.169.254/latest', 'https://0.0.0.0/x',
    'https://[::1]/x', 'https://[fd00::1]/x', 'https://[fc12::1]/x', 'https://[fe80::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://2130706433/x',
  ])('webhook %s (loopback / private / link-local literal) is refused', async (url) => {
    await pool.query(`DELETE FROM admin_settings WHERE key = 'health_alert_webhook_url'`);
    const r = await call(alertRoute as Route, 'PATCH', { health_alert_webhook_url: url });
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/public/i);
    expect(await stored('health_alert_webhook_url')).toBeUndefined();
  }, 30000);

  it.each(['https://172.15.0.1/x', 'https://172.32.0.1/x', 'https://hooks.example.com/x', 'https://8.8.8.8/x'])('webhook %s is allowed', async (url) => {
    const r = await call(alertRoute as Route, 'PATCH', { health_alert_webhook_url: url });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }, 30000);

  it('concurrent PATCHes serialise: exactly one reports the change, the other unchanged', async () => {
    await pool.query(`DELETE FROM admin_settings WHERE key = 'health_alert_email'`);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    const rs = await Promise.all([1, 2, 3, 4].map(() => call(alertRoute as Route, 'PATCH', { health_alert_email: 'same@example.co.za' })));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const rows = (await pool.query(`SELECT details FROM admin_audit_log WHERE admin_user_id = $1`, [admin])).rows
      .map((r) => (r.details as { changes: Record<string, string> }).changes.health_alert_email);
    expect(rows.filter((c) => c === 'set')).toHaveLength(1);
    expect(rows.filter((c) => c === 'unchanged')).toHaveLength(3);
  }, 30000);

  it('an invalid non-blank email is still rejected and the stored value is untouched', async () => {
    await call(alertRoute as Route, 'PATCH', { health_alert_email: 'keep@example.co.za' });
    const r = await call(alertRoute as Route, 'PATCH', { health_alert_email: 'not-an-email' });
    expect(r.status).toBe(400);
    expect(await stored('health_alert_email')).toBe('keep@example.co.za');
  }, 30000);
});
