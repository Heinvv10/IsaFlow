/**
 * Financial years API
 * GET /api/accounting/fiscal-years - every stored financial year (label, dates,
 * months, kind, status) with its periods. A transition year is a row of its own.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { listYearsWithPeriods } from '@/modules/accounting/services/gl/yearsWithPeriodsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  return apiResponse.success(res, await listYearsWithPeriods(companyId));
}

export default withAuth(withErrorHandler(handler as any));
