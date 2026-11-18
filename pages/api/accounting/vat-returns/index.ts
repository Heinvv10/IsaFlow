/**
 * VAT Returns API
 *
 * GET  /api/accounting/vat-returns?year=2026
 *   → listVATReturns — paginated list of submitted VAT returns.
 *
 * POST /api/accounting/vat-returns
 *   Body: { periodStart: string; periodEnd: string; sarsReference?: string;
 *           acknowledgeLedgerGap?: boolean; ledgerGapReason?: string }
 *   → submitVATReturn — computes VAT, posts clearing journal, records submission.
 *
 * Idempotent: POSTing the same period twice returns 400. A period with no finalised or filed
 * VAT201 version (the return lifecycle) is 409 before anything is written, as is one whose version drifted from the
 * VAT201 (never overridable) or whose control accounts differ from it (an owner or admin may settle anyway with
 * acknowledgeLedgerGap and a ledgerGapReason, kept on the settlement).
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
import {
  withAuth,
  type CompanyAuthedRequest,
  type AuthenticatedNextApiRequest,
  withWriteAccess, withVatVendor} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  submitVATReturn,
  listVATReturns,
} from '@/modules/accounting/services/reports/vatSubmissionService';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { ReturnRefusal } from '@/modules/accounting/services/returns/returnVersionTypes';
import { respondReturnRefusal } from '@/modules/accounting/services/returns/respondRefusal';

/** 999g's vat_returns_ledger_gap_ck holds the same cap. */
const LEDGER_GAP_REASON_MAX = 1000;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { year } = req.query;
    const records = await listVATReturns(companyId, {
      year: year ? Number(year) : undefined,
    });
    return apiResponse.success(res, { items: records, total: records.length });
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const userId = req.user.id;
    const { periodStart, periodEnd, sarsReference, acknowledgeLedgerGap, ledgerGapReason } = req.body as {
      periodStart?: string;
      periodEnd?: string;
      sarsReference?: string;
      acknowledgeLedgerGap?: unknown;
      ledgerGapReason?: unknown;
    };

    if (!periodStart || !periodEnd) {
      return apiResponse.badRequest(res, 'periodStart and periodEnd are required');
    }
    if (acknowledgeLedgerGap !== undefined && typeof acknowledgeLedgerGap !== 'boolean') {
      return apiResponse.badRequest(res, 'acknowledgeLedgerGap must be true or false');
    }
    if (acknowledgeLedgerGap === true && typeof ledgerGapReason !== 'string') {
      return apiResponse.badRequest(res, 'ledgerGapReason is required with acknowledgeLedgerGap');
    }
    if (typeof ledgerGapReason === 'string' && ledgerGapReason.length > LEDGER_GAP_REASON_MAX) {
      return apiResponse.badRequest(res, `ledgerGapReason is at most ${LEDGER_GAP_REASON_MAX} characters`);
    }
    const { companyRole } = req as CompanyAuthedRequest;

    try {
      const record = await withJournalDateRefusal(res, () => submitVATReturn(
        companyId,
        {
          periodStart, periodEnd, sarsReference,
          acknowledgeLedgerGap: acknowledgeLedgerGap === true
            ? { reason: ledgerGapReason as string, role: companyRole } : undefined,
        },
        userId,
      ));
      if (record === JOURNAL_DATE_REFUSED) return;
      return apiResponse.success(res, record);
    } catch (err) {
      if (respondIfLockTimeout(res, err)) return;
      if (respondIfImpersonationForbidden(res, err)) return;
      if (err instanceof ReturnRefusal) return respondReturnRefusal(res, err); // 409: finalise the VAT201 first
      log.error('VAT return submission failed', { error: err, companyId }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'VAT submission failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withVatVendor(withCsrf(withWriteAccess(handler)))));
