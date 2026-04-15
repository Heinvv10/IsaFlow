/**
 * Admin Platform Settings API
 * GET  /api/admin/settings — Read platform settings
 * PATCH /api/admin/settings — Update platform settings (MVP: no persistence)
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { getPlatformSettings, updatePlatformSettings } from '@/modules/admin/services/analyticsService';
import type { PlatformSettings } from '@/modules/admin/types/admin.types';

const PatchBody = z.object({
  maintenance_mode:       z.boolean().optional(),
  registration_enabled:   z.boolean().optional(),
  default_trial_days:     z.number().int().min(1).max(365).optional(),
  max_companies_per_user: z.number().int().min(1).max(100).optional(),
  smtp_configured:        z.boolean().optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const settings = await getPlatformSettings();
      return apiResponse.success(res, settings);
    } catch (err) {
      log.error('Failed to get platform settings', { error: err }, 'admin-settings-api');
      return apiResponse.badRequest(res, 'Failed to get platform settings');
    }
  }

  if (req.method === 'PATCH') {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const data = parsed.data as Partial<PlatformSettings>;
      await updatePlatformSettings(data, req.user.id);

      log.info('Platform settings PATCH', { keys: Object.keys(data), userId: req.user.id }, 'admin-settings-api');

      // Audit log
      await sql`
        INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details, ip_address)
        VALUES (
          ${req.user.id},
          'update_platform_settings',
          'platform',
          NULL,
          ${JSON.stringify(data)}::jsonb,
          ${req.headers['x-forwarded-for']?.toString() ?? req.socket?.remoteAddress ?? null}
        )
      `;

      return apiResponse.success(res, { message: 'Settings saved.' });
    } catch (err) {
      log.error('Failed to update platform settings', { error: err }, 'admin-settings-api');
      return apiResponse.badRequest(res, 'Failed to update platform settings');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PATCH']);
}

export default withAdmin(handler);
