/**
 * Batch Payment Actions API
 * POST — approve, process, cancel
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  approveBatch,
  processBatch,
  cancelBatch,
  BatchNotProcessableError,
} from '@/modules/accounting/services/ap/batchPaymentService';
import {
  isRetryableSupplierPaymentRefusal,
  isSupplierPaymentRefusal,
} from '@/modules/accounting/services/ap/supplierPaymentRefusal';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { action, id } = req.body;
    const userId = req.user.id;
    if (!action || !id) return apiResponse.badRequest(res, 'action and id are required');

    switch (action) {
      case 'approve': {
        await approveBatch(companyId, id, userId);
        return apiResponse.success(res, { status: 'approved' });
      }
      case 'process': {
        await processBatch(companyId, id, userId);
        return apiResponse.success(res, { status: 'processed' });
      }
      case 'cancel':
        await cancelBatch(companyId, id);
        return apiResponse.success(res, { status: 'cancelled' });
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    log.error('Batch payment action failed', { error: err }, 'accounting-api');
    // Only the two refusals raised BEFORE the first posting may be answered
    // with a 4xx: withAuth COMMITs anything below 500, so a blanket
    // badRequestFromError committed a half-processed batch — a posted journal
    // with the invoices not updated — and reported it to the user as a 400.
    if (err instanceof BatchNotProcessableError) {
      return apiResponse.conflict(res, err.message);
    }
    if (err instanceof Error && err.message === 'Batch not found') {
      return apiResponse.notFound(res, 'Batch');
    }
    // K-063/K-066: a bill no longer payable, raised before the claim. A
    // contended bill is a retry, not the user's mistake.
    if (isRetryableSupplierPaymentRefusal(err)) return apiResponse.conflict(res, (err as Error).message);
    if (isSupplierPaymentRefusal(err)) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
