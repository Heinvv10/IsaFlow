/**
 * Payroll Employees API (new payroll_employees table)
 * GET  /api/payroll/employees  - List active payroll employees (?include=terminated: leavers too)
 * POST /api/payroll/employees  - Create a payroll employee, with an optional salary: { componentId, amountCents },
 *                                in integer cents (.../[id]/components takes `amount`, in rands; `amount` is refused here)
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
import { listPayrollEmployees } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import {
  createEmployeeWithPay,
  EmployeeOnboardingRefused,
} from '@/modules/accounting/services/payroll/payrollEmployeeOnboarding';

async function handler(
  req: AuthenticatedNextApiRequest,
  res: NextApiResponse
): Promise<void> {
  const { companyId, companyRole, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    // ?include=terminated adds leavers (the tax-directive form's employee picker).
    const employees = await listPayrollEmployees(companyId, { includeTerminated: req.query.include === 'terminated' });
    // Personal data is for write roles; a viewer gets who the employees are, nothing else.
    return apiResponse.success(res, canWrite(companyRole) ? employees : employees.map(employeeNamesOnly));
  }

  if (req.method === 'POST') {
    try {
      const employee = await createEmployeeWithPay(companyId, user.id, req.body as Record<string, unknown>);
      return apiResponse.created(res, employee);
    } catch (err) {
      // Raised only before the first write (a 4xx commits); anything later rethrows, so it rolls back.
      if (err instanceof EmployeeOnboardingRefused) return apiResponse.badRequest(res, err.message);
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
