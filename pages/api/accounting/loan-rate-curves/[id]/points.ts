/**
 * Rate Curve Points API
 * GET  — list rate points for a curve
 * POST — bulk upsert rate points
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  getRatePointsForCurve,
  upsertRatePoints,
  type RatePointInput,
} from '@/modules/accounting/services/loans/loanRateCurveService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const curveId = String(req.query.id);

  if (req.method === 'GET') {
    const points = await getRatePointsForCurve(companyId, curveId);
    return apiResponse.success(res, points);
  }

  if (req.method === 'POST') {
    const { points } = req.body as { points: RatePointInput[] };
    if (!Array.isArray(points)) return apiResponse.badRequest(res, 'points array required');
    const count = await upsertRatePoints(companyId, curveId, points);
    return apiResponse.success(res, { count });
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
