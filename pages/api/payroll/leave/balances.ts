/**
 * GET /api/payroll/leave/balances?year=YYYY — leave balances per employee for a given year
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { listLeaveBalances } from '@/modules/accounting/services/payroll/payrollLeaveService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();

  const balances = await listLeaveBalances(companyId, year);
  return apiResponse.success(res, balances);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
