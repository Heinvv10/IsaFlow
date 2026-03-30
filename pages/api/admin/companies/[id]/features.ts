/**
 * Admin Company Features API
 * GET    /api/admin/companies/[id]/features — Effective features for a company
 * POST   /api/admin/companies/[id]/features — Set a feature override
 * DELETE /api/admin/companies/[id]/features — Remove a feature override
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  getCompanyEffectiveFeatures,
  setCompanyFeatureOverride,
  removeCompanyFeatureOverride,
} from '@/modules/admin/services/featureFlagService';
import { logAdminAction } from '@/modules/admin/services/auditService';

function getIp(req: AuthenticatedNextApiRequest): string | null {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

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
    try {
      const { feature_id, enabled, reason } = req.body as {
        feature_id?: string;
        enabled?: boolean;
        reason?: string;
      };

      if (!feature_id) return apiResponse.badRequest(res, 'feature_id is required');
      if (enabled === undefined || enabled === null) {
        return apiResponse.badRequest(res, 'enabled is required');
      }
      if (!reason) return apiResponse.badRequest(res, 'reason is required');

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
    try {
      const { feature_id } = req.body as { feature_id?: string };

      if (!feature_id) return apiResponse.badRequest(res, 'feature_id is required');

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
