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

  it('an invalid non-blank email is still rejected and the stored value is untouched', async () => {
    await call(alertRoute as Route, 'PATCH', { health_alert_email: 'keep@example.co.za' });
    const r = await call(alertRoute as Route, 'PATCH', { health_alert_email: 'not-an-email' });
    expect(r.status).toBe(400);
    expect(await stored('health_alert_email')).toBe('keep@example.co.za');
  }, 30000);
});
