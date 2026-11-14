/**
 * Payroll Employee Detail API
 * GET   /api/payroll/employees/[id]  - Get single payroll employee
 * PATCH /api/payroll/employees/[id]  - Update payroll employee
 */

import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
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
import { canSetPayrollNetPay, canWrite } from '@/lib/auth/writeRoles';
import { employeeNamesOnly } from '@/modules/accounting/services/payroll/payrollEmployeeRedaction';
import {
  EmployeeOnboardingRefused,
  EmployeeTermsForbidden,
  employeeChangesOf,
} from '@/modules/accounting/services/payroll/payrollEmployeeOnboarding';
import { EMPLOYEE_TERM_LOG_KEYS, EmployeeTermsRefused } from '@/modules/accounting/services/payroll/payrollEmployeeTerms';
import { EmployeeEndDateDirectiveError } from '@/modules/accounting/services/payroll/payrollRunDirectiveUses';
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
  // Employee terms and personal data: never cached (wave-5 rule 14).
  res.setHeader('Cache-Control', 'no-store');

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
      const changes = employeeChangesOf(req.body as Record<string, unknown>, current, canSetPayrollNetPay(companyRole));
      const updated = await updatePayrollEmployee(id, companyId, changes, user.id);
      if (!updated) return apiResponse.notFound(res, 'PayrollEmployee', id);
      return apiResponse.success(res, updated);
    } catch (err) {
      if (err instanceof EmployeeTermsForbidden) return apiResponse.forbidden(res, err.message);
      if (err instanceof EmployeeOnboardingRefused || err instanceof EmployeeTermsRefused) return apiResponse.badRequest(res, err.message);
      // An end date that would un-explain a directive ended at the leave date before a run it taxed (DR): before the write.
      if (err instanceof EmployeeEndDateDirectiveError) return apiResponse.conflict(res, err.message, { code: err.code });
      // An end date, any s18A value or a status/basis/hours/rate key waits for the company's payroll lock (an approval in
      // flight), and every patch for the employee's row lock: a timeout is a retry, not a server error.
      if (respondIfLockTimeout(res, err)) return;
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH']);
}

// The terms are pay detail: the request log masks them.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler)), { maskBodyKeys: EMPLOYEE_TERM_LOG_KEYS }));
