/**
 * Admin Alert Settings API
 * GET  /api/admin/alert-settings — Read health alert configuration
 * PATCH /api/admin/alert-settings — Update health alert configuration
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
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

const PatchBody = z.object({
  health_alert_email:       z.string().email().optional(),
  health_alert_webhook_url: z.string().url().optional(),
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
      return apiResponse.badRequest(res, patchParsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const data = patchParsed.data;

      const entries = (Object.entries(data) as [string, unknown][]).filter(
        ([key]) => (ALERT_KEYS as readonly string[]).includes(key),
      );

      for (const [key, val] of entries) {
        const strVal = typeof val === 'string' ? val : String(val ?? '');
        await sql`
          INSERT INTO admin_settings (key, value, updated_at, updated_by)
          VALUES (${key}, ${JSON.stringify(strVal)}::jsonb, NOW(), ${req.user.id})
          ON CONFLICT (key)
          DO UPDATE SET
            value      = EXCLUDED.value,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by
        `;
      }

      log.info('Alert settings updated', { keys: entries.map(([k]) => k), userId: req.user.id }, 'admin-alert-settings-api');

      await sql`
        INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details, ip_address)
        VALUES (
          ${req.user.id},
          'update_alert_settings',
          'platform',
          NULL,
          ${JSON.stringify({ keys: entries.map(([k]) => k) })}::jsonb,
          ${req.headers['x-forwarded-for']?.toString() ?? req.socket?.remoteAddress ?? null}
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

export default withAdmin(handler);
