/**
 * VAT Adjustment Actions API
 * POST — approve, cancel
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess, withVatVendor} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  approveVATAdjustment,
  cancelVATAdjustment,
  VatAdjustmentRefusal,
} from '@/modules/accounting/services/reports/vatAdjustmentService';
import { isLockContention } from '@/modules/accounting/services/core/lockContention';
import { ClosedFiscalPeriodError, InactiveAccountError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 23505 on the journal-number index: a concurrent journal took the number (R-043); retryable. */
function isEntryNumberCollision(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === '23505'
    && (err as { constraint?: unknown }).constraint === 'uq_gl_je_company_entry_number';
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { action, id } = req.body;
    const userId = req.user.id;
    if (!action || !id) return apiResponse.badRequest(res, 'action and id are required');
    if (typeof id !== 'string' || !UUID.test(id)) return apiResponse.badRequest(res, 'id must be a uuid');

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
    if (err instanceof VatAdjustmentRefusal) {
      if (err.kind === 'not_found') return apiResponse.notFound(res, 'VAT adjustment', String(req.body?.id));
      if (err.kind === 'contended') return apiResponse.conflict(res, err.message);
      return apiResponse.badRequest(res, err.message);
    }
    // Everything below was raised inside approve's savepoint (rolled back) or aborted the
    // transaction, so none of these answers commits a write.
    if (isLockContention(err) || isEntryNumberCollision(err)) {
      return apiResponse.conflict(res, 'Another posting was in progress — retry in a moment.');
    }
    if (err instanceof ClosedFiscalPeriodError || err instanceof InactiveAccountError || err instanceof VatPeriodLockedError) {
      return apiResponse.badRequest(res, err.message);
    }
    log.error('VAT adjustment action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequestFromError(res, err, 'Action failed');
  }
}

 
export default withAuth(withErrorHandler(withVatVendor(withCsrf(withWriteAccess(handler)))));
