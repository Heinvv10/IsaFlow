// tests/integration/admin-health-alert-claim.int.test.ts
//
// ONE ALERT PER HEALTH CHANGE, HOWEVER MANY PASSES RACE FOR IT (admin audit OP-1).
//
// checkAndAlert runs from the 5-minute cron pass AND from every open
// /admin/health tab. It used to read the debounce state, send, and only then
// save it, so passes that overlapped at a transition all sent. The decision is
// now claimed under a transaction-scoped advisory lock and written before the
// send (healthAlertState.ts). Concurrency and the real rows are the point, so
// this runs on a disposable database; only email delivery and the webhook POST
// are stubbed (a slow send keeps the passes overlapping), and nothing leaves.
//
// Also on real rows: an alert that reached no channel releases its claim so the
// next pass retries (review L-b), one channel delivering keeps it, and a
// successful scheduled pass is what the Health page's "last ran" reads (M2).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';

const sendEmail = vi.hoisted(() => vi.fn());
const safeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail }));
vi.mock('@/lib/safeFetch', () => ({ safeFetch }));

import { checkAndAlert } from '@/modules/admin/services/healthAlertService';
import { recordScheduledRun } from '@/modules/admin/services/healthAlertState';
import { buildSystemHealth } from '@/modules/admin/services/systemHealthService';

const DATABASE_URL = process.env.DATABASE_URL;
const KEYS = ['health_alert_last_status', 'health_alert_last_sent_at', 'health_alert_email',
  'health_alert_webhook_url', 'health_alerts_last_scheduled_run'];
const SEND_MS = 300; // long enough that every racing pass has decided before the first send returns

const describeIfDb = isDisposableDb(DATABASE_URL) ? describe : describe.skip;

describeIfDb('health alerts: claim before send, on real rows', () => {
  let pool: Pool;
  let saved: Array<{ key: string; value: unknown }> = [];

  const snapshot = (status: 'degraded' | 'critical') => ({
    overall_status: status, checked_at: new Date().toISOString(),
    db: { status: 'ok', latency_ms: 1, size_mb: 1 },
    job_queue: { pending: 0, running: 0, failed: 60, oldest_pending_age_minutes: null },
    email: { sent_24h: 0, failed_24h: 0, bounced_24h: 0, success_rate_percent: null },
    users_signed_in_24h: 0, trials: { expiring_in_7d: 0 }, recent_errors: [], scheduled_check: { last_run_at: null },
  }) as never;
  const setting = async (key: string) =>
    (await pool.query<{ value: unknown }>('SELECT value FROM admin_settings WHERE key = $1', [key])).rows[0]?.value ?? null;
  const put = (key: string, value: string) => pool.query(
    `INSERT INTO admin_settings (key, value) VALUES ($1, to_jsonb($2::text))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);

  beforeAll(async () => {
    assertDisposableDb('it rewrites the platform health-alert settings');
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    saved = (await pool.query('SELECT key, value FROM admin_settings WHERE key = ANY($1)', [KEYS])).rows;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.ADMIN_ALERT_WEBHOOK_URL;
    sendEmail.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, SEND_MS));
      return { success: true };
    });
    safeFetch.mockResolvedValue({ ok: true, status: 200 });
    await pool.query('DELETE FROM admin_settings WHERE key = ANY($1)', [KEYS]);
    await put('health_alert_email', 'alerts@example.test');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM admin_settings WHERE key = ANY($1)', [KEYS]);
    for (const r of saved) {
      await pool.query('INSERT INTO admin_settings (key, value) VALUES ($1, $2)', [r.key, JSON.stringify(r.value)]);
    }
    await pool.end();
  });

  it('four passes racing at one transition send exactly one alert', async () => {
    await Promise.all([1, 2, 3, 4].map(() => checkAndAlert(snapshot('critical'))));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await setting('health_alert_last_status')).toBe('critical');
    // And the next pass inside the hour stays quiet.
    await checkAndAlert(snapshot('critical'));
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a change of status alerts again, once', async () => {
    await checkAndAlert(snapshot('degraded'));
    await Promise.all([1, 2, 3].map(() => checkAndAlert(snapshot('critical'))));
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('no channel delivered: the claim is released, the previous state is back, the next pass sends', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await put('health_alert_last_status', 'degraded');
    await put('health_alert_last_sent_at', twoHoursAgo);
    sendEmail.mockResolvedValueOnce({ success: false, error: 'SMTP 550' });

    await expect(checkAndAlert(snapshot('critical'))).rejects.toThrow('reached no channel');
    expect(await setting('health_alert_last_status')).toBe('degraded');
    expect(await setting('health_alert_last_sent_at')).toBe(twoHoursAgo);

    await checkAndAlert(snapshot('critical'));
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(await setting('health_alert_last_status')).toBe('critical');
  });

  it('no state before a failed send: released to "never alerted", so the next pass sends', async () => {
    sendEmail.mockResolvedValueOnce({ success: false, error: 'SMTP 550' });
    await expect(checkAndAlert(snapshot('degraded'))).rejects.toThrow('reached no channel');
    await checkAndAlert(snapshot('degraded'));
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('email refused but the webhook delivered: the claim stands and the next pass is quiet', async () => {
    await put('health_alert_webhook_url', 'https://hooks.example.test/x');
    sendEmail.mockResolvedValueOnce({ success: false, error: 'SMTP 550' });
    await checkAndAlert(snapshot('critical'));
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(await setting('health_alert_last_status')).toBe('critical');
    await checkAndAlert(snapshot('critical'));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it('the snapshot carries the last successful scheduled pass', async () => {
    expect((await buildSystemHealth()).scheduled_check.last_run_at).toBeNull();
    const at = new Date('2026-11-15T10:05:00.000Z');
    await recordScheduledRun(at);
    expect((await buildSystemHealth()).scheduled_check.last_run_at).toBe(at.toISOString());
  });
});
