/**
 * Health Alert Service
 * Sends alerts via email and/or webhook when system health degrades or becomes critical.
 * Debounced: alerts on a status change, else at most once an hour per status. The
 * decision is claimed under an advisory lock BEFORE sending (healthAlertState.ts), so
 * the 5-minute cron pass and an open /admin/health tab never both send one change.
 * When no channel delivers, the claim is released and the next pass retries.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { BRAND, emailLayout } from '@/lib/email-templates';
import { safeFetch } from '@/lib/safeFetch';
import type { SystemHealthResponse } from './systemHealthService';
import {
  claimAlert, markHealthy, recordDeliveryOutcome, releaseClaim, settingText, type AlertableStatus,
} from './healthAlertState';

type Row = DbRow;

// ─── Admin Settings helpers ───────────────────────────────────────────────────

async function getAdminSetting(key: string): Promise<string | null> {
  const rows = await sql`
    SELECT value FROM admin_settings WHERE key = ${key}
  `;
  if (rows.length === 0) return null;
  return settingText((rows[0] as Row).value);
}

// ─── Email alert ──────────────────────────────────────────────────────────────

/** True when the SMTP server accepted the alert. Never throws: a failure is logged and is false. */
async function sendEmailAlert(
  health: SystemHealthResponse,
  alertEmail: string,
): Promise<boolean> {
  const statusLabel = health.overall_status.toUpperCase();
  const subject = `[IsaFlow] System Health ${statusLabel} — ${health.checked_at}`;

  const statusColor = health.overall_status === 'critical' ? '#dc2626' : '#d97706';
  const rowStyle = `padding:8px 12px; border-top:1px solid ${BRAND.borderColor}; font-family:${BRAND.fontStack}; font-size:13px; color:${BRAND.textBody};`;
  const html = emailLayout(`
    <tr>
      <td style="padding:36px 32px 28px;">
        <p style="margin:0 0 6px; font-family:${BRAND.fontStack}; font-size:12px;
                  color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">
          Admin Health Alert
        </p>
        <h1 style="margin:0 0 16px; font-family:${BRAND.fontStack}; font-size:22px;
                   font-weight:bold; color:${statusColor};">
          System Health: ${statusLabel}
        </h1>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
               style="border:1px solid ${BRAND.borderColor}; border-radius:6px; border-collapse:collapse;">
          <tr style="background:${BRAND.outerBg};">
            <th style="text-align:left; padding:8px 12px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">Metric</th>
            <th style="text-align:left; padding:8px 12px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">Value</th>
          </tr>
          <tr><td style="${rowStyle}">DB Status</td><td style="${rowStyle}">${health.db.status} (${health.db.latency_ms}ms)</td></tr>
          <tr><td style="${rowStyle}">Failed Jobs</td><td style="${rowStyle}">${health.job_queue.failed}</td></tr>
          <tr><td style="${rowStyle}">Email Accepted by SMTP (24h)</td><td style="${rowStyle}">${health.email.success_rate_percent === null ? 'no email sent' : `${health.email.success_rate_percent}%`}</td></tr>
          <tr><td style="${rowStyle}">Checked At</td><td style="${rowStyle}">${health.checked_at}</td></tr>
        </table>
        <p style="margin:20px 0 0; font-family:${BRAND.fontStack}; font-size:12px; color:${BRAND.textMuted};">
          This is an automated alert from IsaFlow admin health monitoring.
        </p>
      </td>
    </tr>`);

  try {
    const result = await sendEmail({
      to: alertEmail,
      subject,
      html,
      _log: { companyId: null, emailType: 'other', sentBy: 'system:health-alert' },
    });
    if (result.success) {
      log.info('Health alert email sent', { to: alertEmail, status: health.overall_status }, 'healthAlertService');
      return true;
    }
    log.warn('Health alert email failed', { to: alertEmail, error: result.error }, 'healthAlertService');
    return false;
  } catch (err) {
    log.warn('Health alert email threw', { to: alertEmail, error: err instanceof Error ? err.message : err }, 'healthAlertService');
    return false;
  }
}

// ─── Webhook alert ────────────────────────────────────────────────────────────

/** True on a 2xx. Never throws: a refused, failed or non-2xx post is logged and is false. */
export async function sendWebhookAlert(
  health: SystemHealthResponse,
  webhookUrl: string,
): Promise<boolean> {
  const payload = {
    status: health.overall_status,
    checked_at: health.checked_at,
    db_latency_ms: health.db.latency_ms,
    failed_jobs: health.job_queue.failed,
    email_success_rate: health.email.success_rate_percent,
  };

  try {
    // safeFetch re-resolves the host and rejects private/reserved/metadata addresses
    // before connecting — the webhook URL is admin-supplied and otherwise only format-
    // validated, so a plain fetch() here is an SSRF sink (pentest H3).
    const res = await safeFetch(
      webhookUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      { timeoutMs: 10_000 },
    );

    if (!res.ok) {
      log.warn('Health alert webhook returned non-2xx', { status: res.status, webhookUrl }, 'healthAlertService');
      return false;
    }
    log.info('Health alert webhook delivered', { webhookUrl, httpStatus: res.status }, 'healthAlertService');
    return true;
  } catch (err) {
    log.warn('Health alert webhook failed', { error: err instanceof Error ? err.message : err, webhookUrl }, 'healthAlertService');
    return false;
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

/** The Health page's "could not be delivered" warning reads this; failing to write it never changes the alert's outcome. */
async function noteOutcome(delivered: boolean): Promise<void> {
  await recordDeliveryOutcome(delivered).catch((err: unknown) => {
    log.error('Health alert delivery outcome could not be recorded', { delivered, error: err }, 'healthAlertService');
  });
}

/**
 * Alert on a degraded/critical snapshot unless this status was already alerted (see the
 * header). Throws when the alert reached no channel, after releasing the claim.
 */
export async function checkAndAlert(health: SystemHealthResponse): Promise<void> {
  const status = health.overall_status;

  if (status === 'healthy') {
    // Clear last status so next degraded event always fires
    await markHealthy().catch((err: unknown) => {
      log.warn('Failed to reset health_alert_last_status', { error: err }, 'healthAlertService');
    });
    return;
  }

  // Recipients first: nothing after the claim may throw before the send.
  const [dbEmail, dbWebhook] = await Promise.all([
    getAdminSetting('health_alert_email'),
    getAdminSetting('health_alert_webhook_url'),
  ]);
  const alertEmail = dbEmail
    ?? process.env.ADMIN_ALERT_EMAIL
    ?? 'admin@isaflow.co.za';
  const webhookUrl = dbWebhook ?? process.env.ADMIN_ALERT_WEBHOOK_URL ?? null;

  const claim = await claimAlert(status as AlertableStatus);
  if (!claim) {
    log.info('Health alert suppressed (debounced)', { status }, 'healthAlertService');
    return;
  }

  const [emailSent, webhookSent] = await Promise.all([
    sendEmailAlert(health, alertEmail),
    webhookUrl ? sendWebhookAlert(health, webhookUrl) : Promise.resolve(false),
  ]);
  // One channel is enough: the claim stands and the failed one is not retried, by design.
  if (emailSent || webhookSent) {
    await noteOutcome(true);
    return;
  }

  const released = await releaseClaim(claim);
  await noteOutcome(false);
  log.error('Health alert reached no channel; the next pass retries',
    { status, webhook: Boolean(webhookUrl), claimReleased: released }, 'healthAlertService');
  throw new Error(`Health alert (${status}) reached no channel`);
}
