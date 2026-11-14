/**
 * Admin Platform Settings API
 * GET /api/admin/settings - Read platform settings (read-only: smtp_configured is derived from env)
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getPlatformSettings } from '@/modules/admin/services/analyticsService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  try {
    const settings = await getPlatformSettings();
    return apiResponse.success(res, settings);
  } catch (err) {
    log.error('Failed to get platform settings', { error: err }, 'admin-settings-api');
    return apiResponse.badRequest(res, 'Failed to get platform settings');
  }
}

export default withAdmin(withCsrf(handler));
