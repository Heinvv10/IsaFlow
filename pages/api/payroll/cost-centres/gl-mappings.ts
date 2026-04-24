/**
 * GET /api/payroll/cost-centres/gl-mappings
 * Returns every mapping for the caller's company joined with centre +
 * account display info.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { listCostCentreGlMappings } from '@/modules/accounting/services/payroll/costCentreGlMappingService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const rows = await listCostCentreGlMappings(companyId);
  return apiResponse.success(res, rows);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
