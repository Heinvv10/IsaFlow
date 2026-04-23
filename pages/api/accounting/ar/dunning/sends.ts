/**
 * GET /api/accounting/ar/dunning/sends
 *   ?invoiceId=...&responseAction=paid|promised|disputed|silent|none&limit=...
 *
 * Returns the company's dunning send history for the runs UI.
 * PRD-06 Phase 5. Company-scoped, auth-required.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { listSends } from '@/modules/accounting/services/ar/dunningAdmin';
import type { ResponseAction } from '@/modules/accounting/services/ar/dunningService';

const RESPONSE_FILTERS: Array<ResponseAction | 'none'> = [
  'paid', 'promised', 'disputed', 'silent', 'none',
];

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
    return;
  }
  const { companyId } = req as CompanyAuthedRequest;
  const invoiceId =
    typeof req.query.invoiceId === 'string' && req.query.invoiceId.length > 0
      ? req.query.invoiceId
      : undefined;
  const responseActionRaw =
    typeof req.query.responseAction === 'string' ? req.query.responseAction : undefined;
  const responseAction =
    responseActionRaw && (RESPONSE_FILTERS as string[]).includes(responseActionRaw)
      ? (responseActionRaw as ResponseAction | 'none')
      : undefined;
  const limit = Math.min(Math.max(1, Number(req.query.limit ?? 100)), 500);

  const sends = await listSends(companyId, {
    customerInvoiceId: invoiceId,
    responseAction,
    limit,
  });
  apiResponse.success(res, { sends });
}

export default withAuth(withErrorHandler(handler));
