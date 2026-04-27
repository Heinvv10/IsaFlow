/**
 * Admin Feature Flag Detail API
 * GET   /api/admin/features/[id] — Get a specific feature flag
 * PATCH /api/admin/features/[id] — Update name, description, or is_global
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  getFeatureFlag,
  updateFeatureFlag,
} from '@/modules/admin/services/featureFlagService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PatchBody = z.object({
  name:        z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  is_global:   z.boolean().optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const id = req.query.id as string;

  if (req.method === 'GET') {
    try {
      const flag = await getFeatureFlag(id);
      if (!flag) return apiResponse.notFound(res, 'FeatureFlag', id);
      return apiResponse.success(res, flag);
    } catch (err) {
      log.error('Failed to get feature flag', { id, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to get feature flag');
    }
  }

  if (req.method === 'PATCH') {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const { name, description, is_global } = parsed.data;

      await updateFeatureFlag(id, { name, description, is_global });

      await logAdminAction(
        req.user.id,
        'feature_flag.update',
        'feature_flag',
        id,
        { name, description, is_global },
        getIp(req)
      );

      const updated = await getFeatureFlag(id);
      if (!updated) return apiResponse.notFound(res, 'FeatureFlag', id);
      return apiResponse.success(res, updated);
    } catch (err) {
      log.error('Failed to update feature flag', { id, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to update feature flag');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PATCH']);
}

export default withAdmin(withCsrf(handler));
