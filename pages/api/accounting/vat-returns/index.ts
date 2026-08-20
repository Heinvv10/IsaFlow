/**
 * VAT Returns API
 *
 * GET  /api/accounting/vat-returns?year=2026
 *   → listVATReturns — paginated list of submitted VAT returns.
 *
 * POST /api/accounting/vat-returns
 *   Body: { periodStart: string; periodEnd: string; sarsReference?: string }
 *   → submitVATReturn — computes VAT, posts clearing journal, records submission.
 *
 * Idempotent: POSTing the same period twice returns 400.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
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
    const { periodStart, periodEnd, sarsReference } = req.body as {
      periodStart?: string;
      periodEnd?: string;
      sarsReference?: string;
    };

    if (!periodStart || !periodEnd) {
      return apiResponse.badRequest(res, 'periodStart and periodEnd are required');
    }

    try {
      const record = await submitVATReturn(
        companyId,
        { periodStart, periodEnd, sarsReference },
        userId,
      );
      return apiResponse.success(res, record);
    } catch (err) {
      log.error('VAT return submission failed', { error: err, companyId }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'VAT submission failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withVatVendor(withCsrf(withWriteAccess(handler)))));
