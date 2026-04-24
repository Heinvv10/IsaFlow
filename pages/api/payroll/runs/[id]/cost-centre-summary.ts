/**
 * GET /api/payroll/runs/:id/cost-centre-summary
 * Returns per-cost-centre totals for a payroll run, including an
 * "Unassigned" bucket for employees with no cost_centre_id.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { costCentreSummaryForRun } from '@/modules/accounting/services/payroll/costCentreService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing run id');

  try {
    const result = await costCentreSummaryForRun(companyId, id);
    return apiResponse.success(res, result);
  } catch (err) {
    return apiResponse.notFound(res, err instanceof Error ? err.message : 'Run not found');
  }
}

export default withAuth(withErrorHandler(handler));
