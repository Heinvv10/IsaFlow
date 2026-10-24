/**
 * SARS VAT201 API
 * GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD — generate VAT201 data for period
 * POST { periodStart, periodEnd }     — save as draft submission
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess, withVatVendor} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { isValidDate } from '@/lib/validation';
import { saveDraftSubmission } from '@/modules/accounting/services/reports/sarsService';
// The ledger-derived boxes, not the invoice-derived ones: a period's credit
// notes and manual VAT journals are invisible to `generateVAT201` (audit K-031).
// `sarsFields` is the SARS form (1, 1A ... 20) the page renders; the field1..11
// keys beside it are storage keys for drafts and the filing path.
import { getVat201Return } from '@/modules/accounting/services/reports/vat201LedgerFields';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const from = req.query.from as string;
    const to = req.query.to as string;

    if (!from || !to) {
      return apiResponse.badRequest(res, 'from and to query parameters are required (YYYY-MM-DD)');
    }
    if (!isValidDate(from) || !isValidDate(to)) {
      return apiResponse.badRequest(res, 'from and to must be valid dates in YYYY-MM-DD format');
    }

    try {
      const vat201 = await getVat201Return(companyId, from, to);
      return apiResponse.success(res, vat201);
    } catch (err) {
      log.error('Failed to generate VAT201', { error: err }, 'sars-api');
      return apiResponse.badRequestFromError(res, err, 'Failed to generate VAT201');
    }
  }

  if (req.method === 'POST') {
    const { periodStart, periodEnd } = req.body;

    if (!periodStart || !periodEnd) {
      return apiResponse.badRequest(res, 'periodStart and periodEnd are required');
    }
    if (!isValidDate(periodStart) || !isValidDate(periodEnd)) {
      return apiResponse.badRequest(res, 'periodStart and periodEnd must be valid dates in YYYY-MM-DD format');
    }

    try {
      const vat201 = await getVat201Return(companyId, periodStart, periodEnd);
      const submission = await saveDraftSubmission(
        companyId,
        'VAT201',
        periodStart,
        periodEnd,
        vat201 as unknown as Record<string, unknown>,
        userId
      );
      return apiResponse.created(res, submission, 'VAT201 draft saved');
    } catch (err) {
      if (respondIfLockTimeout(res, err)) return;
      log.error('Failed to save VAT201 draft', { error: err }, 'sars-api');
      return apiResponse.badRequestFromError(res, err, 'Failed to save draft');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withVatVendor(withCsrf(withWriteAccess(handler)))));
