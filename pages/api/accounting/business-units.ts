/**
 * Business Units API
 * GET  — list all business units
 * POST — create a new business unit
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getBusinessUnits, createBusinessUnit } from '@/modules/accounting/services/businessUnitService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const activeOnly = req.query.active === 'true';
    const items = await getBusinessUnits(companyId, activeOnly);
    return apiResponse.success(res, { items });
  }

  if (req.method === 'POST') {
    const { code, name, description } = req.body;
    if (!code || !name) return apiResponse.badRequest(res, 'code and name are required');
    try {
      const bu = await createBusinessUnit(companyId, { code, name, description }, userId);
      return apiResponse.success(res, bu);
    } catch (err) {
      log.error('Failed to create business unit', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
