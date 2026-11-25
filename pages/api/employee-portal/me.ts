/**
 * GET /api/employee-portal/me: the signed-in employee's name and number, the employer's name (wave 6 SS), and their
 * address and bank account (bank name and last four only), read-only (wave 7 EA1, W5; employeePortalDetails.ts).
 * Read by the session's own ids only. 401 without a valid employee portal session. No-store.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withEmployeePortalAuth, type EmployeePortalRequest } from '@/lib/auth/employeePortalAuth';
import { readPortalDetails } from '@/modules/accounting/services/payroll/employeePortalDetails';

async function handler(req: EmployeePortalRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId, employeeId } = req.employeePortal;
  const details = await readPortalDetails(companyId, employeeId);
  if (!details) return apiResponse.notFound(res, 'Employee');
  return apiResponse.success(res, details);
}

export default withErrorHandler(withEmployeePortalAuth(handler));
