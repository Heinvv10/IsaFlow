/**
 * Payroll Employee Detail API
 * GET /api/payroll/employees-detail?id=xxx  - Get single employee
 * PUT /api/payroll/employees-detail?id=xxx  - Update employee
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  getEmployee,
  updateEmployee,
  getEmployeePayHistory,
  getEmployeePayslips,
} from '@/modules/payroll/payrollService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return apiResponse.badRequest(res, 'Employee ID is required');
  }

  if (req.method === 'GET') {
    try {
      const employee = await getEmployee(companyId, id);
      if (!employee) {
        return apiResponse.notFound(res, 'Employee', id);
      }

      const payHistory = await getEmployeePayHistory(companyId, id);
      const payslips = await getEmployeePayslips(companyId, id);

      return apiResponse.success(res, {
        ...employee,
        pay_history: payHistory,
        payslip_history: payslips,
      });
    } catch (err) {
      log.error('employee detail GET failed', { id, error: err }, 'payroll-api');
      return apiResponse.internalError(res, err, 'Failed to fetch employee');
    }
  }

  if (req.method === 'PUT') {
    try {
      const body = req.body ?? {};
      const { validateSaIdNumber, validateSaTaxNumber, isDuplicateIdNumber } =
        await import('@/modules/payroll/payrollValidationService');

      if (body.id_number) {
        const r = validateSaIdNumber(String(body.id_number).trim());
        if (!r.valid) return apiResponse.badRequest(res, `ID number: ${r.reason}`);
        const dup = await isDuplicateIdNumber(companyId, String(body.id_number).trim(), id);
        if (dup) return apiResponse.badRequest(res, 'An employee with this ID number already exists');
      }
      if (body.tax_number) {
        const r = validateSaTaxNumber(String(body.tax_number).trim());
        if (!r.valid) return apiResponse.badRequest(res, `Tax number: ${r.reason}`);
      }

      const userId = (req as CompanyAuthedRequest).user?.id ?? null;
      const employee = await updateEmployee(companyId, id, body, userId);
      return apiResponse.success(res, employee);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update employee';
      log.error('employee detail PUT failed', { id, error: err }, 'payroll-api');
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT']);
}

 
export default withAuth(withErrorHandler(withCsrf(handler)));
