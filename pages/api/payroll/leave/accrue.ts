/**
 * POST /api/payroll/leave/accrue?year=YYYY&month=MM
 *
 * Advances payroll_leave_balances.accrued for all active employees × leave
 * types to the expected amount as at the end of the given month (idempotent).
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { runMonthlyAccrual } from '@/modules/accounting/services/payroll/payrollLeaveService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
  const month = req.query.month ? Number(req.query.month) : new Date().getMonth() + 1;

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return apiResponse.badRequest(res, 'month query param must be 1..12');
  }
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    return apiResponse.badRequest(res, 'year query param is invalid');
  }

  const result = await runMonthlyAccrual(companyId, year, month);
  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
