/**
 * Payroll Employees API (new payroll_employees table)
 * GET  /api/payroll/employees  - List payroll employees
 * POST /api/payroll/employees  - Create a payroll employee
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
  listPayrollEmployees,
  createPayrollEmployee,
} from '@/modules/accounting/services/payroll/payrollEmployeeService';
import type { PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

async function handler(
  req: AuthenticatedNextApiRequest,
  res: NextApiResponse
): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const employees = await listPayrollEmployees(companyId);
    return apiResponse.success(res, employees);
  }

  if (req.method === 'POST') {
    const {
      firstName, lastName, employeeNumber, employmentType, startDate,
      taxNumber, idNumber, dateOfBirth, uifExcluded,
      medicalAidMainMember, medicalAidDependantsCount,
    } = req.body as Record<string, unknown>;

    if (!firstName || !lastName || !employeeNumber || !employmentType || !startDate) {
      return apiResponse.badRequest(
        res,
        'firstName, lastName, employeeNumber, employmentType, startDate are required'
      );
    }

    const data: Omit<PayrollEmployee, 'id' | 'companyId'> = {
      firstName: String(firstName),
      lastName: String(lastName),
      employeeNumber: String(employeeNumber),
      employmentType: String(employmentType) as PayrollEmployee['employmentType'],
      startDate: new Date(String(startDate)),
      endDate: req.body.endDate ? new Date(String(req.body.endDate)) : undefined,
      taxNumber: taxNumber ? String(taxNumber) : undefined,
      idNumber: idNumber ? String(idNumber) : undefined,
      dateOfBirth: dateOfBirth ? new Date(String(dateOfBirth)) : undefined,
      uifExcluded: Boolean(uifExcluded),
      medicalAidMainMember: medicalAidMainMember !== false,
      medicalAidDependantsCount: Number(medicalAidDependantsCount) || 0,
    };

    const employee = await createPayrollEmployee(companyId, data);
    return apiResponse.created(res, employee);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
