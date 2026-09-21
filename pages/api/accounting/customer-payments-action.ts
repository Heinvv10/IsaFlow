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
import { isRetryableContention } from '@/modules/accounting/services/core/retryableContention';

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
        const payment = await confirmCustomerPayment(companyId, paymentId, userId);
        return apiResponse.success(res, payment);
      }
      case 'cancel': {
        const cancelled = await cancelCustomerPayment(companyId, paymentId, userId, reason);
        return apiResponse.success(res, cancelled);
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    // 409 for contention — the AR mirror of `supplier-payments-action`.
    // `confirm` and `cancel` take the receipt's row lock first, so nothing has
    // been written when this fires, and `customer-allocations` answers the same
    // event 409 already.
    if (isRetryableContention(err)) {
      log.info('Customer payment action hit a contended row', { error: err }, 'accounting-api');
      return apiResponse.conflict(res, (err as Error).message);
    }
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Customer payment action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
