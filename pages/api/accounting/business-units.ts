/**
 * Business Units API
 * GET  — list all business units
 * POST — create a new business unit
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { BusinessUnitActionError, getBusinessUnits, createBusinessUnit } from '@/modules/accounting/services/core/businessUnitService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const activeOnly = req.query.active === 'true';
    const items = await getBusinessUnits(companyId, activeOnly);
    return apiResponse.success(res, { items });
  }

  if (req.method === 'POST') {
    const { code, name, description, division } = req.body;
    if (!code || !name) return apiResponse.badRequest(res, 'code and name are required');
    const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
    try {
      // Lengths and the case-insensitive duplicate check live in the service (shared with MCP).
      const bu = await createBusinessUnit(companyId, {
        code: String(code), name: String(name), description: text(description), division: text(division),
      });
      return apiResponse.success(res, bu);
    } catch (err) {
      if (err instanceof BusinessUnitActionError) return apiResponse.badRequest(res, err.message);
      log.error('Failed to create business unit', { error: err }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'Failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
