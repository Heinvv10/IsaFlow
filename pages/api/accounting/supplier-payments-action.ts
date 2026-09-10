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
import {
  SupplierPaymentNotProcessableError,
  voidSupplierPayment,
} from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';

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
    log.error('Supplier payment action failed', { error: err }, 'accounting-api');
    // Only refusals raised BEFORE the first posting may be answered with a 4xx:
    // `withAuth` COMMITs anything below 500, so the blanket badRequest this
    // replaced committed a half-processed payment — a posted journal with the
    // bills not updated — and reported it to the user as a 400.
    if (err instanceof SupplierPaymentNotProcessableError) {
      return apiResponse.conflict(res, err.message);
    }
    if (err instanceof Error && /not found$/.test(err.message)) {
      return apiResponse.notFound(res, 'Payment');
    }
    // approveSupplierPayment refuses a non-draft payment before it writes
    // anything, so this one stays a 400.
    if (err instanceof Error && err.message.startsWith('Cannot approve payment with status')) {
      return apiResponse.badRequest(res, err.message);
    }
    throw err;
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
