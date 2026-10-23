/**
 * Batch Payment Actions API
 * POST — approve, process, cancel
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  approveBatch,
  processBatch,
  cancelBatch,
  BatchNotProcessableError,
  BatchNotApprovableError,
} from '@/modules/accounting/services/ap/batchPaymentService';
import { respondIfApprovalRequired } from '@/modules/accounting/services/gl/approvalGateResponse';
import { respondIfBankControlRefused } from '@/modules/accounting/services/bank/bankControlResponse';
import { BatchAlreadyReversedError, reverseBatch } from '@/modules/accounting/services/ap/batchPaymentReversal';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { BatchChangedSinceApprovalError } from '@/modules/accounting/services/ap/batchApprovedDigest';
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
        if (await withJournalDateRefusal(res, () => processBatch(companyId, id, userId)) === JOURNAL_DATE_REFUSED) return;
        return apiResponse.success(res, { status: 'processed' });
      }
      case 'cancel':
        await cancelBatch(companyId, id);
        return apiResponse.success(res, { status: 'cancelled' });
      case 'reverse': {
        // A PROCESSED batch: one contra of the batch journal, every bill
        // un-applied by this batch's allocations, members voided. Same gate as
        // every other action here, and as single-payment void.
        const reversal = await withJournalDateRefusal(res, () => reverseBatch(companyId, id, userId));
        if (reversal === JOURNAL_DATE_REFUSED) return;
        return apiResponse.success(res, { status: 'reversed', ...reversal });
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    // A held row — the batch (`DocumentClaimLockTimeoutError`), a bill, the journal — is a lock timeout: 503 +
    // Retry-After (D8 round 18), never the 409 below, which answers the batch's state.
    if (respondIfLockTimeout(res, err)) return;
    // R-035 PR5: approve and process refuse an ungated batch under its row
    // lock, before any write — 409 with the reason; withAuth commits nothing.
    if (respondIfApprovalRequired(res, err)) return;
    // Step 2: reversing a batch a statement line is matched to, by its maker, an agent or "login as" — 403, pre-write.
    if (respondIfBankControlRefused(res, err)) return;
    log.error('Batch payment action failed', { error: err }, 'accounting-api');
    // Only the refusals raised BEFORE the first posting or write may be answered
    // with a 4xx: withAuth COMMITs anything below 500, so a blanket
    // badRequestFromError committed a half-processed batch — a posted journal
    // with the invoices not updated — and reported it to the user as a 400.
    if (err instanceof BatchNotProcessableError || err instanceof BatchNotApprovableError
        || err instanceof BatchAlreadyReversedError) {
      return apiResponse.conflict(res, err.message, { reason: err.code });
    }
    // Migration 922: process refuses a batch whose content changed since it was approved; re-approve is the way out.
    if (err instanceof BatchChangedSinceApprovalError) {
      return apiResponse.conflict(res, err.message, { reason: err.code, batchId: err.batchId });
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
