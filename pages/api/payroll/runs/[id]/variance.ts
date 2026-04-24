/**
 * GET /api/payroll/runs/[id]/variance
 *
 * Returns the run's totals + per-employee deltas vs the immediately preceding
 * non-cancelled, non-draft run. If there is no prior run the diffs are
 * vs zero (everything looks "new").
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { getPayrollRunVariance } from '@/modules/accounting/services/payroll/payrollVarianceService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing run id');

  try {
    const variance = await getPayrollRunVariance(id, companyId);
    return apiResponse.success(res, variance);
  } catch (err) {
    return apiResponse.badRequestFromError(res, err, 'Variance load failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(handler)));
