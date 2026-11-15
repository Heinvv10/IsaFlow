/**
 * Admin Company Features API
 * GET    /api/admin/companies/[id]/features — Effective features for a company
 * POST   /api/admin/companies/[id]/features — Set a feature override
 * DELETE /api/admin/companies/[id]/features — Remove a feature override
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminUuid, isPgError, AdminUuid } from '@/modules/admin/middleware/adminRequestErrors';
import { apiResponse } from '@/lib/apiResponse';
import {
  getCompanyEffectiveFeatures,
  setCompanyFeatureOverride,
  removeCompanyFeatureOverride,
} from '@/modules/admin/services/featureFlagService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PostBody = z.object({
  feature_id: AdminUuid,
  enabled:    z.boolean(),
  reason:     z.string().min(1).max(500),
}).strict();

const DeleteBody = z.object({
  feature_id: AdminUuid,
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = adminUuid(req.query.id, 'company id');

  if (req.method === 'GET') {
    const features = await getCompanyEffectiveFeatures(companyId);
    return apiResponse.success(res, features);
  }

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    const { feature_id, enabled, reason } = parsed.data;

    try {
      await setCompanyFeatureOverride(
        companyId,
        feature_id,
        enabled,
        reason,
        req.user.id
      );
    } catch (err) {
      // The INSERT is the first write: the refusal aborted the transaction, so nothing lands.
      if (isPgError(err, '23503', ['company_feature_overrides_company_id_fkey', 'company_feature_overrides_feature_id_fkey'])) return apiResponse.notFound(res, 'Company or feature');
      throw err;
    }

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
  }

  if (req.method === 'DELETE') {
    const delParsed = DeleteBody.safeParse(req.body);
    if (!delParsed.success) {
      return apiResponse.badRequest(res, delParsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    const { feature_id } = delParsed.data;

    // No override to remove is a 404 before the audit row (breaker #1405 round 2 sweep).
    if (!(await removeCompanyFeatureOverride(companyId, feature_id))) return apiResponse.notFound(res, 'Feature override');

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
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

export default withAdmin(withCsrf(handler));
