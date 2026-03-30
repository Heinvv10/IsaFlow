/**
 * Admin Platform Settings API
 * GET  /api/admin/settings — Read platform settings
 * PATCH /api/admin/settings — Update platform settings (MVP: no persistence)
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { getPlatformSettings, updatePlatformSettings } from '@/modules/admin/services/analyticsService';
import type { PlatformSettings } from '@/modules/admin/types/admin.types';

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
    try {
      const data = req.body as Partial<PlatformSettings>;
      await updatePlatformSettings(data);

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

      return apiResponse.success(res, { message: 'Settings updated (note: no persistence yet)' });
    } catch (err) {
      log.error('Failed to update platform settings', { error: err }, 'admin-settings-api');
      return apiResponse.badRequest(res, 'Failed to update platform settings');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PATCH']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
