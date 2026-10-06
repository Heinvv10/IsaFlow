/**
 * Recurring Invoice Actions API
 * POST — pause, resume, cancel, generate
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { assertTxUsable } from '@/lib/als';
import {
  updateRecurringStatus,
  runRecurringInvoice,
} from '@/modules/accounting/services/ar/recurringInvoiceService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  try {
    const { action, id } = req.body;
    const userId = req.user.id;
    if (!action || !id) return apiResponse.badRequest(res, 'action and id are required');

    switch (action) {
      case 'pause':
        await updateRecurringStatus(companyId, id, 'paused');
        return apiResponse.success(res, { status: 'paused' });
      case 'resume':
        await updateRecurringStatus(companyId, id, 'active');
        return apiResponse.success(res, { status: 'active' });
      case 'cancel':
        await updateRecurringStatus(companyId, id, 'cancelled');
        return apiResponse.success(res, { status: 'cancelled' });
      case 'generate': {
        // R-035 PR4: a gated invoice is generated as a draft awaiting approval, and says so.
        const { invoiceId, heldForApproval } = await runRecurringInvoice(companyId, id, userId);
        return apiResponse.success(res, heldForApproval ? { invoiceId, heldForApproval } : { invoiceId });
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    if (respondIfLockTimeout(res, err)) return;
    log.error('Recurring invoice action failed', { error: err }, 'accounting-api');
    // A 4xx is COMMITted by withAuth. That is right for a refusal, which writes
    // nothing — but not when the failure poisoned the request transaction, so
    // let that one through as a 500 and be rolled back.
    assertTxUsable();
    return apiResponse.badRequestFromError(res, err, 'Action failed');
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
