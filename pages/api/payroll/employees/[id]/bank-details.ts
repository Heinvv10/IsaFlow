/**
 * GET /api/payroll/employees/[id]/bank-details — the employee's active details, or null; the account number is in
 *     full for owner / admin, else masked to its last four.
 * PUT — enter or change them: { bankName, branchCode, accountNumber, accountType, accountHolder? }. The first entry:
 *     owner / admin / manager. A change to existing details: owner / admin only (403 CHANGE_REQUIRES_ADMIN).
 * A person in their own session only: Login-as is 403 IMPERSONATION_FORBIDDEN, a token 403 AGENT_FORBIDDEN.
 * Every refusal is raised before any write. History: GET /api/accounting/entity-changes, type payroll_bank_detail.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { requireUuidParam } from '@/lib/schemas/common';
import { assertHumanSession } from '@/modules/accounting/services/bank/bankControlRefusal';
import { respondIfBankControlRefused } from '@/modules/accounting/services/bank/bankControlResponse';
import {
  getEmployeeBankDetails, parseBankDetailsInput, PayrollBankDetailsRefusal, setEmployeeBankDetails,
} from '@/modules/accounting/services/payroll/payrollBankDetailsService';
import { getPayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';

function respondIfRefused(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof PayrollBankDetailsRefusal)) return false;
  if (err.code === 'INVALID') apiResponse.validationError(res, err.fieldErrors ?? {});
  else if (err.code === 'EMPLOYEE_NOT_FOUND') apiResponse.notFound(res, 'Employee');
  else apiResponse.error(res, ErrorCode.FORBIDDEN, err.message, { reason: err.code });
  return true;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'PUT') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
  }
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const employeeId = requireUuidParam(req, res, 'id');
  if (!employeeId) return;
  try {
    await assertHumanSession('read or change employee bank details');
    if (req.method === 'GET') {
      if (!(await getPayrollEmployee(employeeId, companyId))) return apiResponse.notFound(res, 'Employee');
      return apiResponse.success(res, await getEmployeeBankDetails(companyId, employeeId, companyRole));
    }
    const input = parseBankDetailsInput(req.body);
    return apiResponse.success(res, await setEmployeeBankDetails(companyId, employeeId, input, companyRole));
  } catch (err) {
    if (respondIfBankControlRefused(res, err) || respondIfRefused(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
