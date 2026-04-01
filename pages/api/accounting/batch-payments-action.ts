/**
 * Batch Payment Actions API
 * POST — approve, process, cancel
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  approveBatch,
  processBatch,
  cancelBatch,
} from '@/modules/accounting/services/batchPaymentService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;

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
    const msg = err instanceof Error ? err.message : 'Action failed';
    log.error('Batch payment action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, msg);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
