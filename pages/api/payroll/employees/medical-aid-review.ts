/**
 * Payroll Medical-Aid Review API
 * GET /api/payroll/employees/medical-aid-review
 *
 * Active employees marked as medical-aid main members with no medical-aid
 * deduction assigned. Read-only; personal data, so write roles only.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { canWrite } from '@/lib/auth/writeRoles';
import { listMainMembersWithoutMedicalDeduction } from '@/modules/accounting/services/payroll/payrollMedicalAidReviewService';

async function handler(
  req: AuthenticatedNextApiRequest,
  res: NextApiResponse
): Promise<void> {
  const { companyId, companyRole } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  if (!canWrite(companyRole)) {
    return apiResponse.forbidden(res, 'The medical-aid review is for the roles that manage payroll');
  }

  const employees = await listMainMembersWithoutMedicalDeduction(companyId);
  return apiResponse.success(res, { count: employees.length, employees });
}

export default withAuth(withErrorHandler(handler));
