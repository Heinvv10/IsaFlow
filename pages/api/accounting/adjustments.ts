/**
 * Accounting Adjustments API
 * GET  — list adjustments (filter by ?entityType=customer|supplier)
 * POST — create adjustment
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { getAdjustments, createAdjustment } from '@/modules/accounting/services/items/adjustmentService';
import { CustomerNotInCompanyError, SupplierNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

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
      // R-067 / R-068: both fences run before any write, so the 4xx commits
      // nothing; surface the typed message rather than the generic fallback.
      if (err instanceof SupplierNotInCompanyError || err instanceof CustomerNotInCompanyError) {
        return apiResponse.badRequest(res, err.message);
      }
      log.error('Adjustment create failed', { error: err }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
