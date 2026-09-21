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
import { SupplierNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';
import { getBatchMembers } from '@/modules/accounting/services/ap/batchPaymentMembers';
import {
  isRetryableSupplierPaymentRefusal,
  isSupplierPaymentRefusal,
} from '@/modules/accounting/services/ap/supplierPaymentRefusal';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { id, status, limit, offset } = req.query;

    // Single batch by ID
    if (id) {
      const batch = await getBatchById(companyId, id as string);
      if (!batch) return apiResponse.notFound(res, 'Batch', id as string);
      return apiResponse.success(res, { ...batch, payments: await getBatchMembers(companyId, batch.id) });
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
      // R-068: refused before the batch row is written; surface the typed message.
      if (err instanceof SupplierNotInCompanyError) return apiResponse.badRequest(res, err.message);
      // K-064: every bill line is checked before the first write, so both
      // answers COMMIT nothing. Contention on a bill is a retry, not a mistake.
      if (isRetryableSupplierPaymentRefusal(err)) return apiResponse.conflict(res, (err as Error).message);
      if (isSupplierPaymentRefusal(err)) return apiResponse.badRequest(res, err.message);
      log.error('Batch payment create failed', { error: err }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
