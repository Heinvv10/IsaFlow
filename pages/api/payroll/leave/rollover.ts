/**
 * POST /api/payroll/leave/rollover?fromYear=YYYY&toYear=YYYY
 *
 * Rolls payroll_leave_balances from fromYear into toYear, applying each
 * leave type's max_carry_over cap. Negative balances roll as zero.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { rolloverLeaveYear } from '@/modules/accounting/services/payroll/payrollLeaveService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const fromYear = Number(req.query.fromYear);
  const toYear = Number(req.query.toYear);

  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear)) {
    return apiResponse.badRequest(res, 'fromYear and toYear query params are required and must be integers');
  }
  if (toYear <= fromYear) {
    return apiResponse.badRequest(res, 'toYear must be greater than fromYear');
  }

  const result = await rolloverLeaveYear(companyId, fromYear, toYear);
  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
