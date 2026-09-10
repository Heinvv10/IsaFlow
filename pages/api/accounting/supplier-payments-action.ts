/**
 * Supplier Payment Actions API
 * POST /api/accounting/supplier-payments-action
 *   action: approve | process | void
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  approveSupplierPayment,
  processSupplierPayment,
} from '@/modules/accounting/services/ap/supplierPaymentService';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { isRetryableContention } from '@/modules/accounting/services/core/retryableContention';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { action, paymentId } = req.body;
    const userId = req.user.id;

    if (!action || !paymentId) {
      return apiResponse.badRequest(res, 'action and paymentId are required');
    }

    switch (action) {
      case 'approve': {
        const payment = await approveSupplierPayment(companyId, paymentId, userId);
        return apiResponse.success(res, payment);
      }
      case 'process': {
        const payment = await processSupplierPayment(companyId, paymentId, userId);
        return apiResponse.success(res, payment);
      }
      case 'void': {
        // P2.1 (audit W4): reverses the GL journal and un-applies allocations.
        const payment = await voidSupplierPayment(companyId, paymentId, userId);
        return apiResponse.success(res, payment);
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    // 409 for contention: `process` and `void` both take the payment row lock
    // as their first act, so a `PAYMENT_LOCK_TIMEOUT` here wrote nothing and
    // retrying is the remedy. It is the same event `supplier-allocations`
    // already answers 409 one call deeper — this route answered it 400.
    if (isRetryableContention(err)) {
      log.info('Supplier payment action hit a contended row', { error: err }, 'accounting-api');
      return apiResponse.conflict(res, (err as Error).message);
    }
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Supplier payment action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
