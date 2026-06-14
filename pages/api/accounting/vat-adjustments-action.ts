/**
 * VAT Adjustment Actions API
 * POST — approve, cancel
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  approveVATAdjustment,
  cancelVATAdjustment,
} from '@/modules/accounting/services/reports/vatAdjustmentService';

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
        const item = await approveVATAdjustment(companyId, id, userId);
        return apiResponse.success(res, item);
      }
      case 'cancel':
        await cancelVATAdjustment(companyId, id);
        return apiResponse.success(res, { status: 'cancelled' });
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    log.error('VAT adjustment action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequestFromError(res, err, 'Action failed');
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
