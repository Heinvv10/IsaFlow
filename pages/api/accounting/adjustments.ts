/**
 * Accounting Adjustments API
 * GET  — list adjustments (filter by ?entityType=customer|supplier)
 * POST — create adjustment
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getAdjustments, createAdjustment } from '@/modules/accounting/services/adjustmentService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const { entityType, status, limit, offset } = req.query;
    const result = await getAdjustments(companyId, {
      entityType: entityType as string,
      status: status as string,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const userId = req.user.id;  // User identity from JWT only
    try {
      const item = await createAdjustment(companyId, req.body, userId);
      return apiResponse.success(res, item);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Create failed';
      log.error('Adjustment create failed', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
