/**
 * Revenue Pipeline Report
 * GET /api/accounting/practice/reports/revenue-pipeline?asOfDate=...
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { getRevenuePipeline } from '@/modules/accounting/services/practice/practiceReportsService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const { asOfDate } = req.query;
  const rows = await getRevenuePipeline(companyId, {
    asOfDate: asOfDate as string | undefined,
  });
  return apiResponse.success(res, rows);
}

export default withAuth(withErrorHandler(handler));
