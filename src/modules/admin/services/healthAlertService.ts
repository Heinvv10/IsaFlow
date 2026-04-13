/**
 * Health Alert Service
 * Sends alerts via email and/or webhook when system health degrades or becomes critical.
 * Debounced: won't re-alert if status hasn't changed within the last hour.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import type { SystemHealthResponse } from '../../../../pages/api/admin/health';

type Row = DbRow;

type AlertableStatus = 'degraded' | 'critical';

const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// ─── Admin Settings helpers ───────────────────────────────────────────────────

async function getAdminSetting(key: string): Promise<string | null> {
  const rows = await sql`
    SELECT value FROM admin_settings WHERE key = ${key}
  `;
  if (rows.length === 0) return null;
  const raw = (rows[0] as Row).value;
  if (raw === null || raw === undefined) return null;
  // admin_settings stores JSONB — scalars are stored as JSON strings (e.g. `"foo"`)
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'string' ? parsed : String(parsed);
    } catch {
      return raw;
    }
  }
  return String(raw);
}

async function setAdminSetting(key: string, value: string): Promise<void> {
  await sql`
    INSERT INTO admin_settings (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, NOW())
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

// ─── Debounce logic ───────────────────────────────────────────────────────────

interface AlertState {
  lastStatus: string | null;
  lastSentAt: Date | null;
}

async function getAlertState(): Promise<AlertState> {
  const rows = await sql`
    SELECT key, value FROM admin_settings
    WHERE key IN ('health_alert_last_status', 'health_alert_last_sent_at')
  `;

  const map: Record<string, string> = {};
  for (const r of rows as Row[]) {
    const k = String(r.key ?? '');
    const v = r.value;
    if (v === null || v === undefined) continue;
    let parsed: string;
    if (typeof v === 'string') {
      try { parsed = JSON.parse(v) as string; } catch { parsed = v; }
    } else {
      parsed = String(v);
    }
    map[k] = parsed;
  }

  return {
    lastStatus: map['health_alert_last_status'] ?? null,
    lastSentAt: map['health_alert_last_sent_at']
      ? new Date(map['health_alert_last_sent_at'])
      : null,
  };
}

async function saveAlertState(status: string): Promise<void> {
  const now = new Date().toISOString();
  await Promise.all([
    setAdminSetting('health_alert_last_status', status),
    setAdminSetting('health_alert_last_sent_at', now),
  ]);
}

function shouldAlert(state: AlertState, currentStatus: string): boolean {
  const statusChanged = state.lastStatus !== currentStatus;
  if (statusChanged) return true;
  if (!state.lastSentAt) return true;
  return Date.now() - state.lastSentAt.getTime() > ALERT_COOLDOWN_MS;
}

// ─── Email alert ──────────────────────────────────────────────────────────────

async function sendEmailAlert(
  health: SystemHealthResponse,
  alertEmail: string,
): Promise<void> {
  const statusLabel = health.overall_status.toUpperCase();
  const subject = `[ISAFlow] System Health ${statusLabel} — ${health.checked_at}`;

  const html = `
    <h2 style="color:${health.overall_status === 'critical' ? '#dc2626' : '#d97706'}">
      ISAFlow System Health: ${statusLabel}
    </h2>
    <table style="border-collapse:collapse;width:100%;max-width:500px;font-family:sans-serif;font-size:14px">
      <tr><th style="text-align:left;padding:6px 12px;background:#f3f4f6">Metric</th><th style="text-align:left;padding:6px 12px;background:#f3f4f6">Value</th></tr>
      <tr><td style="padding:6px 12px;border-top:1px solid #e5e7eb">DB Status</td><td style="padding:6px 12px;border-top:1px solid #e5e7eb">${health.db.status} (${health.db.latency_ms}ms)</td></tr>
      <tr><td style="padding:6px 12px;border-top:1px solid #e5e7eb">Failed Jobs</td><td style="padding:6px 12px;border-top:1px solid #e5e7eb">${health.job_queue.failed}</td></tr>
      <tr><td style="padding:6px 12px;border-top:1px solid #e5e7eb">Email Success Rate</td><td style="padding:6px 12px;border-top:1px solid #e5e7eb">${health.email.success_rate_percent}%</td></tr>
      <tr><td style="padding:6px 12px;border-top:1px solid #e5e7eb">Checked At</td><td style="padding:6px 12px;border-top:1px solid #e5e7eb">${health.checked_at}</td></tr>
    </table>
    <p style="font-size:12px;color:#6b7280;margin-top:16px">This is an automated alert from ISAFlow admin health monitoring.</p>
  `;

  const result = await sendEmail({
    to: alertEmail,
    subject,
    html,
    _log: { companyId: null, emailType: 'other', sentBy: 'system:health-alert' },
  });

  if (result.success) {
    log.info('Health alert email sent', { to: alertEmail, status: health.overall_status }, 'healthAlertService');
  } else {
    log.warn('Health alert email failed', { to: alertEmail, error: result.error }, 'healthAlertService');
  }
}

// ─── Webhook alert ────────────────────────────────────────────────────────────

async function sendWebhookAlert(
  health: SystemHealthResponse,
  webhookUrl: string,
): Promise<void> {
  const payload = {
    status: health.overall_status,
    checked_at: health.checked_at,
    db_latency_ms: health.db.latency_ms,
    failed_jobs: health.job_queue.failed,
    email_success_rate: health.email.success_rate_percent,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      log.warn('Health alert webhook returned non-2xx', { status: res.status, webhookUrl }, 'healthAlertService');
    } else {
      log.info('Health alert webhook delivered', { webhookUrl, httpStatus: res.status }, 'healthAlertService');
    }
  } catch (err) {
    log.warn('Health alert webhook failed', { error: err instanceof Error ? err.message : err, webhookUrl }, 'healthAlertService');
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function checkAndAlert(health: SystemHealthResponse): Promise<void> {
  const status = health.overall_status;

  if (status === 'healthy') {
    // Clear last status so next degraded event always fires
    await setAdminSetting('health_alert_last_status', 'healthy').catch((err: unknown) => {
      log.warn('Failed to reset health_alert_last_status', { error: err }, 'healthAlertService');
    });
    return;
  }

  // Only alert for degraded/critical
  const alertableStatus = status as AlertableStatus;

  const state = await getAlertState();
  if (!shouldAlert(state, alertableStatus)) {
    log.info('Health alert suppressed (debounced)', { status: alertableStatus, lastSentAt: state.lastSentAt }, 'healthAlertService');
    return;
  }

  // Resolve recipients from DB settings, fall back to env
  const [dbEmail, dbWebhook] = await Promise.all([
    getAdminSetting('health_alert_email'),
    getAdminSetting('health_alert_webhook_url'),
  ]);

  const alertEmail = dbEmail
    ?? process.env.ADMIN_ALERT_EMAIL
    ?? 'admin@isaflow.co.za';

  const webhookUrl = dbWebhook ?? process.env.ADMIN_ALERT_WEBHOOK_URL ?? null;

  await Promise.all([
    sendEmailAlert(health, alertEmail),
    webhookUrl ? sendWebhookAlert(health, webhookUrl) : Promise.resolve(),
  ]);

  await saveAlertState(alertableStatus);
}
