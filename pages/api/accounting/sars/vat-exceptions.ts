/**
 * SARS VAT201 Exceptions API
 * GET ?from=YYYY-MM-DD&to=YYYY-MM-DD — pre-filing VAT exceptions report:
 * uncoded GL VAT lines, invoice tax-code issues, invoice↔GL VAT mismatches,
 * and VAT201-box vs GL-control reconciliation. Informational only.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { isValidDate } from '@/lib/validation';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;

  const from = req.query.from as string;
  const to = req.query.to as string;

  if (!from || !to) {
    return apiResponse.badRequest(res, 'from and to query parameters are required (YYYY-MM-DD)');
  }
  if (!isValidDate(from) || !isValidDate(to)) {
    return apiResponse.badRequest(res, 'from and to must be valid dates in YYYY-MM-DD format');
  }

  try {
    const report = await getVatExceptions(companyId, from, to);
    return apiResponse.success(res, report);
  } catch (err) {
    log.error('Failed to generate VAT exceptions report', { error: err }, 'sars-api');
    return apiResponse.badRequestFromError(res, err, 'Failed to generate VAT exceptions report');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
