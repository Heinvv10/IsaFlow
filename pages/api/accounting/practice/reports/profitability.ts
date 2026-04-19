/**
 * Client Profitability Report
 * GET /api/accounting/practice/reports/profitability?dateFrom=...&dateTo=...&practiceClientId=...
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { getClientProfitability } from '@/modules/accounting/services/practice/practiceReportsService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const { dateFrom, dateTo, practiceClientId } = req.query;
  if (!dateFrom || !dateTo) return apiResponse.badRequest(res, 'dateFrom and dateTo are required');
  const rows = await getClientProfitability(companyId, {
    dateFrom: dateFrom as string,
    dateTo: dateTo as string,
    practiceClientId: practiceClientId as string | undefined,
  });
  return apiResponse.success(res, rows);
}

export default withAuth(withErrorHandler(handler));
