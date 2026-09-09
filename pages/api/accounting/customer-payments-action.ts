import {parseArActionOptions} from '@/modules/accounting/services/ar/arActionOptions';
/**
 * Customer Payment Actions API
 * POST /api/accounting/customer-payments-action
 *   action: confirm
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { confirmCustomerPayment, cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { action, paymentId, reason } = req.body;
    const userId = req.user.id;

    if (!action || !paymentId) {
      return apiResponse.badRequest(res, 'action and paymentId are required');
    }

    switch (action) {
      case 'confirm': {
        const payment = await confirmCustomerPayment(companyId, paymentId, userId, parseArActionOptions(req.body));
        return apiResponse.success(res, payment);
      }
      case 'cancel': {
        const cancelled = await cancelCustomerPayment(companyId, paymentId, userId, reason, parseArActionOptions(req.body));
        return apiResponse.success(res, cancelled);
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Customer payment action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
