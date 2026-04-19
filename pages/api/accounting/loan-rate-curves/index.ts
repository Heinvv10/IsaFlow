/**
 * Loan Rate Curves API
 * GET  — list rate curves for company
 * POST — create new rate curve
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import { listRateCurves, createRateCurve, type RateCurveCreateInput } from '@/modules/accounting/services/loans/loanRateCurveService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const curves = await listRateCurves(companyId);
    return apiResponse.success(res, curves);
  }

  if (req.method === 'POST') {
    const body = req.body as RateCurveCreateInput;
    const curve = await createRateCurve(companyId, body);
    return apiResponse.created(res, curve);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
