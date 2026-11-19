/**
 * GET /api/employee-portal/payslips: the signed-in employee's own final payslips, newest first (wave 6 SS;
 * employeePortalReads.listOwnPayslips). The company and employee are the session's. 401 without a portal session.
 * No-store.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withEmployeePortalAuth, type EmployeePortalRequest } from '@/lib/auth/employeePortalAuth';
import { listOwnPayslips } from '@/modules/accounting/services/payroll/employeePortalReads';

async function handler(req: EmployeePortalRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId, employeeId } = req.employeePortal;
  return apiResponse.success(res, await listOwnPayslips(companyId, employeeId));
}

export default withErrorHandler(withEmployeePortalAuth(handler));
