/**
 * Period Close Readiness API
 * GET /api/accounting/fiscal-periods/[periodId]/close-readiness
 *
 * Returns 6-item advisory checklist for a fiscal period:
 * bank_reconciled, unposted_journals, ar_ties, ap_ties, vat_reviewed, tb_balanced.
 *
 * HTTP 200 + { data: CloseReadiness } on success.
 * HTTP 400 if periodId is not a valid UUID format.
 * HTTP 404 if the period does not exist for this company.
 * HTTP 500 for unexpected server errors (handled by withErrorHandler).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getCloseReadiness } from '@/modules/accounting/services/gl/periodCloseReadinessService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { periodId } = req.query;

  if (typeof periodId !== 'string' || !periodId) {
    return apiResponse.badRequest(res, 'periodId is required');
  }

  if (!UUID_RE.test(periodId)) {
    return apiResponse.badRequest(res, 'periodId must be a valid UUID');
  }

  const readiness = await getCloseReadiness(companyId, periodId);

  if (!readiness) {
    return apiResponse.notFound(res, `Fiscal period ${periodId} not found`);
  }

  return apiResponse.success(res, readiness);
}

export default withAuth(withErrorHandler(handler));
