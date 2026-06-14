/**
 * Supplier Batch Payments API
 * GET  — list batches
 * POST — create batch
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { getBatches, getBatchById, createBatch } from '@/modules/accounting/services/ap/batchPaymentService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { id, status, limit, offset } = req.query;

    // Single batch by ID
    if (id) {
      const batch = await getBatchById(companyId, id as string);
      if (!batch) return apiResponse.notFound(res, 'Batch', id as string);
      return apiResponse.success(res, batch);
    }

    const result = await getBatches(companyId, {
      status: status as string,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const userId = req.user.id;  // User identity from JWT only
    try {
      const item = await createBatch(companyId, req.body, userId);
      return apiResponse.success(res, item);
    } catch (err) {
      log.error('Batch payment create failed', { error: err }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
