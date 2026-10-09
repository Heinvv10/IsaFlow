/**
 * Customer Payment Actions API
 * POST /api/accounting/customer-payments-action
 *   action: confirm
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { respondIfReconciliationCompleted } from '@/lib/apiReconciliationCompleted';
import { respondIfBankControlRefused } from '@/modules/accounting/services/bank/bankControlResponse';
import { log } from '@/lib/logger';
import { confirmCustomerPayment, cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentService';
import { isRetryableContention } from '@/modules/accounting/services/core/retryableContention';
import { respondIfBackstopRefused } from '@/modules/accounting/services/gl/approvalGateResponse';

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
        const payment = await withJournalDateRefusal(res, () => confirmCustomerPayment(companyId, paymentId, userId));
        if (payment === JOURNAL_DATE_REFUSED) return;
        return apiResponse.success(res, payment);
      }
      case 'cancel': {
        const cancelled = await withJournalDateRefusal(res, () => cancelCustomerPayment(companyId, paymentId, userId, reason));
        if (cancelled === JOURNAL_DATE_REFUSED) return;
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
    // Any row-lock timeout — the receipt or its bank line too (D8 round 16), the chain head, a document row (round 9) —
    // is 503 + Retry-After, checked first; the 409 below answers only the retryable state conflicts.
    if (respondIfLockTimeout(res, err)) return;
    // D12: cancel of a receipt whose bank line is in a COMPLETED reconciliation — 409, pre-write.
    if (respondIfReconciliationCompleted(res, err)) return;
    // Step 2: cancel of a bank-linked refund by its allocator, an agent or "login as" — 403, before any write.
    if (respondIfBankControlRefused(res, err)) return;
    if (isRetryableContention(err)) {
      log.info('Customer payment action hit a contended row', { error: err }, 'accounting-api');
      return apiResponse.conflict(res, (err as Error).message);
    }
    // R-035 PR4 (review F3): the receipt settles a DRAFT invoice an enforced
    // approval rule governs — the backstop refused it, and confirm's own
    // savepoint has rolled the whole confirm back, so the 409 commits nothing.
    if (respondIfBackstopRefused(res, err, 'This receipt settles a draft invoice that needs approval before it can '
      + 'enter accounts receivable. Have the invoice approved and posted first, then confirm the receipt.')) return;
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Customer payment action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
