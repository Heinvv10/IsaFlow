/**
 * Adjustment Actions API
 * POST — approve, cancel
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  AdjustmentNotApprovableError,
  approveAdjustment,
  cancelAdjustment,
} from '@/modules/accounting/services/items/adjustmentService';

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
        const item = await approveAdjustment(companyId, id, userId);
        return apiResponse.success(res, item);
      }
      case 'cancel':
        await cancelAdjustment(companyId, id);
        return apiResponse.success(res, { status: 'cancelled' });
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    log.error('Adjustment action failed', { error: err }, 'accounting-api');
    // Only refusals raised BEFORE the first posting may be answered with a 4xx:
    // `withAuth` COMMITs anything below 500, so the blanket badRequestFromError
    // this replaced committed a half-approved adjustment — a posted journal
    // whose adjustment still reads 'draft' — and reported it as a 400.
    if (err instanceof AdjustmentNotApprovableError) {
      return apiResponse.conflict(res, err.message);
    }
    if (err instanceof Error && /^Adjustment not found/.test(err.message)) {
      return apiResponse.notFound(res, 'Adjustment');
    }
    throw err;
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
