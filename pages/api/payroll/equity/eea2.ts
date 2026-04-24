/**
 * GET /api/payroll/equity/eea2?asOf=YYYY-MM-DD
 * Returns the level × race × gender matrix + disability/foreign pivots.
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
import { eea2Report } from '@/modules/accounting/services/payroll/equityReportService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const asOfRaw = typeof req.query.asOf === 'string' ? req.query.asOf : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw)) return apiResponse.badRequest(res, 'asOf must be YYYY-MM-DD');
  const report = await eea2Report(companyId, asOfRaw);
  return apiResponse.success(res, report);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
