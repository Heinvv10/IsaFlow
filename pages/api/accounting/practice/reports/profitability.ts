/**
 * Client Profitability Report
 * GET /api/accounting/practice/reports/profitability?dateFrom=...&dateTo=...&practiceClientId=...
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { mayReadPayroll } from '@/lib/auth/payrollReadGate';
import { getClientProfitability } from '@/modules/accounting/services/practice/practiceReportsService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const { dateFrom, dateTo, practiceClientId } = req.query;
  if (!dateFrom || !dateTo) return apiResponse.badRequest(res, 'dateFrom and dateTo are required');
  // census-exempt(getClientProfitability): costVisible below is Payroll read; without it the service runs no cost query and returns null cost and margin
  const rows = await getClientProfitability(companyId, {
    dateFrom: dateFrom as string,
    dateTo: dateTo as string,
    practiceClientId: practiceClientId as string | undefined,
  }, await mayReadPayroll(companyId, user.id)); // timeCost / margin come from per-person cost rates: Payroll read, else null
  return apiResponse.success(res, rows);
}

export default withAuth(withErrorHandler(handler));
