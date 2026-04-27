/**
 * Period Close Readiness API
 * GET /api/accounting/fiscal-periods/[periodId]/close-readiness
 *
 * Returns 6-item advisory checklist for a fiscal period:
 * bank_reconciled, unposted_journals, ar_ties, ap_ties, vat_reviewed, tb_balanced.
 *
 * HTTP 200 + { data: CloseReadiness } on success.
 * HTTP 404 if the period does not exist for this company.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getCloseReadiness } from '@/modules/accounting/services/gl/periodCloseReadinessService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { periodId } = req.query;

  if (typeof periodId !== 'string' || !periodId) {
    return apiResponse.badRequest(res, 'periodId is required');
  }

  try {
    const readiness = await getCloseReadiness(companyId, periodId);

    if (!readiness) {
      return apiResponse.notFound(res, `Fiscal period ${periodId} not found`);
    }

    return apiResponse.success(res, readiness);
  } catch (err) {
    log.error('Failed to get close readiness', { error: err, periodId }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to compute close-readiness checklist');
  }
}

export default withAuth(withErrorHandler(handler));
