/**
 * Feature Check API
 * GET /api/features/check?code=payroll
 * Customer-facing endpoint — not admin-only. Returns whether the current company
 * has access to a given feature flag. Used by the FeatureGate component.
 */

import type { NextApiResponse } from 'next';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { hasFeature } from '@/modules/admin/services/featureFlagService';

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const code = req.query.code as string | undefined;
  if (!code) return apiResponse.badRequest(res, 'code query param required');

  const enabled = await hasFeature(req.companyId, code);
  return apiResponse.success(res, { code, enabled });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
