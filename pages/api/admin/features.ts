/**
 * Admin Feature Flags API
 * GET /api/admin/features — List all feature flags
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { listFeatureFlags } from '@/modules/admin/services/featureFlagService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const flags = await listFeatureFlags();
      return apiResponse.success(res, flags);
    } catch (err) {
      log.error('Failed to list feature flags', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to list feature flags');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
