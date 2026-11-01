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
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { canWrite } from '@/lib/auth/writeRoles';
import { employeeNamesOnly } from '@/modules/accounting/services/payroll/payrollEmployeeRedaction';
import {
  EmployeeOnboardingRefused,
  employeeChangesOf,
} from '@/modules/accounting/services/payroll/payrollEmployeeOnboarding';
import {
  getPayrollEmployee,
  updatePayrollEmployee,
} from '@/modules/accounting/services/payroll/payrollEmployeeService';

async function handler(
  req: AuthenticatedNextApiRequest,
  res: NextApiResponse
): Promise<void> {
  const { companyId, companyRole, user } = req as CompanyAuthedRequest;
  const { id } = req.query;

  if (typeof id !== 'string') {
    return apiResponse.badRequest(res, 'Invalid employee ID');
  }

  if (req.method === 'GET') {
    const employee = await getPayrollEmployee(id, companyId);
    if (!employee) return apiResponse.notFound(res, 'PayrollEmployee', id);
    return apiResponse.success(res, canWrite(companyRole) ? employee : employeeNamesOnly(employee));
  }

  if (req.method === 'PATCH') {
    const current = await getPayrollEmployee(id, companyId);
    if (!current) return apiResponse.notFound(res, 'PayrollEmployee', id);
    try {
      const changes = employeeChangesOf(req.body as Record<string, unknown>, current);
      const updated = await updatePayrollEmployee(id, companyId, changes, user.id);
      if (!updated) return apiResponse.notFound(res, 'PayrollEmployee', id);
      return apiResponse.success(res, updated);
    } catch (err) {
      if (err instanceof EmployeeOnboardingRefused) return apiResponse.badRequest(res, err.message);
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
