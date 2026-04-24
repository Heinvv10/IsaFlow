/**
 * Payroll Employee Detail API
 * GET   /api/payroll/employees/[id]  - Get single payroll employee
 * PATCH /api/payroll/employees/[id]  - Update payroll employee
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  getPayrollEmployee,
  updatePayrollEmployee,
} from '@/modules/accounting/services/payroll/payrollEmployeeService';

async function handler(
  req: AuthenticatedNextApiRequest,
  res: NextApiResponse
): Promise<void> {
  const { companyId, user } = req as CompanyAuthedRequest;
  const { id } = req.query;

  if (typeof id !== 'string') {
    return apiResponse.badRequest(res, 'Invalid employee ID');
  }

  if (req.method === 'GET') {
    const employee = await getPayrollEmployee(id, companyId);
    if (!employee) return apiResponse.notFound(res, 'PayrollEmployee', id);
    return apiResponse.success(res, employee);
  }

  if (req.method === 'PATCH') {
    const updated = await updatePayrollEmployee(id, companyId, req.body as Record<string, unknown>, user.id);
    if (!updated) return apiResponse.notFound(res, 'PayrollEmployee', id);
    return apiResponse.success(res, updated);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
