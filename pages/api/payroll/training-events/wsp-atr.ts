/**
 * GET /api/payroll/training-events/wsp-atr?year=2026
 * Category rollup with planned vs actual cost + status counts.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { wspAtrReport } from '@/modules/accounting/services/payroll/trainingEventService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const yearRaw = typeof req.query.year === 'string' ? req.query.year : '';
  if (!/^\d{4}$/.test(yearRaw)) return apiResponse.badRequest(res, 'year (YYYY) required');
  const report = await wspAtrReport(companyId, Number(yearRaw));
  return apiResponse.success(res, report);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
