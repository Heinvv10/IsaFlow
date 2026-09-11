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
import { MAX_BATCH_PAYMENTS_PER_BATCH } from '@/lib/limits/authorityHoldLimits';

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
    // Processing posts the whole batch in one request holding the company authority key; refused up front with the
    // number, so the caller knows how to split (the service's own check is masked as 'Create failed').
    const requested = (req.body as { payments?: unknown } | undefined)?.payments;
    if (Array.isArray(requested) && requested.length > MAX_BATCH_PAYMENTS_PER_BATCH) {
      return apiResponse.badRequest(res, `Batch requires 1 to ${MAX_BATCH_PAYMENTS_PER_BATCH} payments; `
        + `split ${requested.length} payments into batches of ${MAX_BATCH_PAYMENTS_PER_BATCH}.`);
    }
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
