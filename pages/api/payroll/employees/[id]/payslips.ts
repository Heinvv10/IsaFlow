/**
 * GET /api/payroll/employees/[id]/payslips — the employee's payslips (wave 4 PS): one
 * entry per run, newest first (period, final or DRAFT by the R-035 guard, stored net),
 * for EmployeePayslipsCard. The PDF itself is GET /api/payroll/runs/[runId]/payslips.
 * Payroll-detail roles only; another company's employee is 404; no-store.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { listEmployeePayslips } from '@/modules/accounting/services/payroll/payslipHistory';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const employeeId = req.query.id;
  if (typeof employeeId !== 'string' || !UUID.test(employeeId)) return apiResponse.badRequest(res, 'id must be a UUID');
  const entries = await listEmployeePayslips(companyId, employeeId);
  if (!entries) return apiResponse.notFound(res, 'Employee');
  return apiResponse.success(res, entries);
}

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)))));
