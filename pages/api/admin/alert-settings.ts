/**
 * Admin Alert Settings API
 * GET  /api/admin/alert-settings — Read health alert configuration
 * PATCH /api/admin/alert-settings — Update health alert configuration
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { trustedClientIp } from '@/lib/trustedClientIp';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

interface AlertSettings {
  health_alert_email: string;
  health_alert_webhook_url: string;
}

const ALERT_KEYS: ReadonlyArray<keyof AlertSettings> = [
  'health_alert_email',
  'health_alert_webhook_url',
];

// A blank value clears the setting (the stored row is removed; delivery then falls back to the
// ADMIN_ALERT_* environment values). Whitespace-only counts as blank.
const blankOr = (rule: (v: string) => boolean, message: string) =>
  z.string().trim().refine((v) => v === '' || rule(v), { message });

const isEmail = (v: string) => z.string().email().safeParse(v).success;
const isHttpsUrl = (v: string) => /^https:\/\//i.test(v) && z.string().url().safeParse(v).success;

const PatchBody = z.object({
  health_alert_email:       blankOr(isEmail, 'Alert email must be a valid email address').optional(),
  health_alert_webhook_url: blankOr(isHttpsUrl, 'Webhook URL must be a valid https:// address').optional(),
}).strict();

async function getAlertSettings(): Promise<AlertSettings> {
  const rows = await sql`
    SELECT key, value FROM admin_settings
    WHERE key = ANY(ARRAY['health_alert_email', 'health_alert_webhook_url'])
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
    health_alert_email: map['health_alert_email'] ?? '',
    health_alert_webhook_url: map['health_alert_webhook_url'] ?? '',
  };
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const settings = await getAlertSettings();
      return apiResponse.success(res, settings);
    } catch (err) {
      log.error('Failed to get alert settings', { error: err }, 'admin-alert-settings-api');
      return apiResponse.internalError(res, err);
    }
  }

  if (req.method === 'PATCH') {
    const patchParsed = PatchBody.safeParse(req.body);
    if (!patchParsed.success) {
      return apiResponse.badRequest(res, patchParsed.error.issues[0]?.message ?? 'Invalid input');
    }

    try {
      const current = await getAlertSettings();
      const changes: Record<string, 'set' | 'cleared' | 'unchanged'> = {};

      for (const key of ALERT_KEYS) {
        const next = patchParsed.data[key];
        if (next === undefined) continue;
        if (next === current[key]) { changes[key] = 'unchanged'; continue; }
        if (next === '') {
          await sql`DELETE FROM admin_settings WHERE key = ${key}`;
          changes[key] = 'cleared';
          continue;
        }
        await sql`
          INSERT INTO admin_settings (key, value, updated_at, updated_by)
          VALUES (${key}, ${JSON.stringify(next)}::jsonb, NOW(), ${req.user.id})
          ON CONFLICT (key)
          DO UPDATE SET
            value      = EXCLUDED.value,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by
        `;
        changes[key] = 'set';
      }

      log.info('Alert settings updated', { changes, userId: req.user.id }, 'admin-alert-settings-api');

      // Audit: what happened to each key, never the value (the webhook URL can carry a secret).
      await sql`
        INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details, ip_address)
        VALUES (
          ${req.user.id},
          'update_alert_settings',
          'platform',
          NULL,
          ${JSON.stringify({ changes })}::jsonb,
          ${trustedClientIp(req)}
        )
      `;

      return apiResponse.success(res, { message: 'Alert settings saved.' });
    } catch (err) {
      log.error('Failed to update alert settings', { error: err }, 'admin-alert-settings-api');
      return apiResponse.internalError(res, err);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH']);
}

export default withAdmin(withCsrf(handler));
