/**
 * Cost Centres API
 * GET  — list all cost centres
 * POST — create a new cost centre
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getCostCentres, createCostCentre, type CcType } from '@/modules/accounting/services/costCentreService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const activeOnly = req.query.active === 'true';
    const ccType = req.query.cc_type as CcType | undefined;
    const items = await getCostCentres(companyId, activeOnly, ccType);
    return apiResponse.success(res, { items });
  }

  if (req.method === 'POST') {
    const { code, name, description, department, ccType } = req.body;
    if (!code || !name) return apiResponse.badRequest(res, 'code and name are required');
    try {
      const cc = await createCostCentre(companyId, { code, name, description, department, ccType }, userId);
      return apiResponse.success(res, cc);
    } catch (err) {
      log.error('Failed to create cost centre', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
