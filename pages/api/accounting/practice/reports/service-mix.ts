/**
 * Service Mix Report
 * GET /api/accounting/practice/reports/service-mix?dateFrom=...&dateTo=...
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { getServiceMix } from '@/modules/accounting/services/practice/practiceReportsService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const { dateFrom, dateTo } = req.query;
  if (!dateFrom || !dateTo) return apiResponse.badRequest(res, 'dateFrom and dateTo are required');
  const rows = await getServiceMix(companyId, {
    dateFrom: dateFrom as string,
    dateTo: dateTo as string,
  });
  return apiResponse.success(res, rows);
}

export default withAuth(withErrorHandler(handler));
