/**
 * Admin Company Features API
 * GET    /api/admin/companies/[id]/features — Effective features for a company
 * POST   /api/admin/companies/[id]/features — Set a feature override
 * DELETE /api/admin/companies/[id]/features — Remove a feature override
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  getCompanyEffectiveFeatures,
  setCompanyFeatureOverride,
  removeCompanyFeatureOverride,
} from '@/modules/admin/services/featureFlagService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PostBody = z.object({
  feature_id: z.string().min(1),
  enabled:    z.boolean(),
  reason:     z.string().min(1).max(500),
}).strict();

const DeleteBody = z.object({
  feature_id: z.string().min(1),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = req.query.id as string;

  if (req.method === 'GET') {
    try {
      const features = await getCompanyEffectiveFeatures(companyId);
      return apiResponse.success(res, features);
    } catch (err) {
      log.error('Failed to get company features', { companyId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to get company features');
    }
  }

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const { feature_id, enabled, reason } = parsed.data;

      await setCompanyFeatureOverride(
        companyId,
        feature_id,
        enabled,
        reason,
        req.user.id
      );

      await logAdminAction(
        req.user.id,
        'company_feature.override_set',
        'company',
        companyId,
        { feature_id, enabled, reason },
        getIp(req)
      );

      const updated = await getCompanyEffectiveFeatures(companyId);
      return apiResponse.success(res, updated);
    } catch (err) {
      log.error('Failed to set company feature override', { companyId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to set feature override');
    }
  }

  if (req.method === 'DELETE') {
    const delParsed = DeleteBody.safeParse(req.body);
    if (!delParsed.success) {
      return apiResponse.badRequest(res, delParsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const { feature_id } = delParsed.data;

      await removeCompanyFeatureOverride(companyId, feature_id);

      await logAdminAction(
        req.user.id,
        'company_feature.override_removed',
        'company',
        companyId,
        { feature_id },
        getIp(req)
      );

      const updated = await getCompanyEffectiveFeatures(companyId);
      return apiResponse.success(res, updated);
    } catch (err) {
      log.error('Failed to remove company feature override', { companyId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to remove feature override');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

export default withAdmin(handler);
