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
  SupplierPaymentNotFoundError,
  SupplierPaymentNotProcessableError,
  voidSupplierPayment,
} from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { isRetryableContention } from '@/modules/accounting/services/core/retryableContention';
import { isSupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';

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
    // Checked FIRST, and it does not overlap the typed refusals below: none of
    // those classes is a member of `isRetryableContention`'s union.
    if (isRetryableContention(err)) {
      log.info('Supplier payment action hit a contended row', { error: err }, 'accounting-api');
      return apiResponse.conflict(res, (err as Error).message);
    }
    log.error('Supplier payment action failed', { error: err }, 'accounting-api');
    // Only refusals raised BEFORE the first posting may be answered with a 4xx:
    // `withAuth` COMMITs anything below 500, so the blanket badRequest this
    // replaced committed a half-processed payment — a posted journal with the
    // bills not updated — and reported it to the user as a 400.
    if (err instanceof SupplierPaymentNotProcessableError) {
      return apiResponse.conflict(res, err.message);
    }
    // Typed, not matched: `/not found$/` also matched 'Bank account not found',
    // which processSupplierPayment throws AFTER it has claimed the payment. The
    // 404 that produced was a 4xx after a write, so withAuth COMMITted the claim
    // and the payment was stranded 'processed' with no journal and no retry —
    // every retry hit the claim it had already taken. Anything not typed here
    // falls through to the 500 below, which rolls the claim back with it.
    if (err instanceof SupplierPaymentNotFoundError) {
      return apiResponse.notFound(res, 'Payment');
    }
    // A typed books refusal keeps its 400 AND its wording. Every construction
    // site of `SupplierPaymentRefusal` is a plan/validate function that has
    // written nothing (`supplierAllocationLines`, `supplierBankPaymentService`,
    // `supplierPaymentApplicationService`), which is what makes a 4xx `withAuth`
    // COMMITs safe here. This is NOT the blanket `err.message` badRequest the
    // typed chain replaced: an unclassified error still falls through to the
    // 500 below, which rolls the claim back with it.
    if (isSupplierPaymentRefusal(err)) {
      return apiResponse.badRequest(res, err.message);
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
