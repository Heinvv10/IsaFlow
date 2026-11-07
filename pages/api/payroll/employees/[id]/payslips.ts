/**
 * GET /api/payroll/employees/[id]/payslips — the employee's payslips (wave 4 PS): one
 * entry per run, newest first (period, final or DRAFT by the R-035 guard, stored net),
 * for EmployeePayslipsCard. The PDF itself is GET /api/payroll/runs/[runId]/payslips.
 * Payroll-detail roles only; another company's employee is 404; no-store; rate-limited per
 * user (each entry runs the R-035 guard, so the list is not free).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { log } from '@/lib/logger';
import { checkReportRateLimit, INTERACTIVE_REPORT_LIMIT } from '@/lib/rateLimit';
import { listEmployeePayslips } from '@/modules/accounting/services/payroll/payslipHistory';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const employeeId = req.query.id;
  if (typeof employeeId !== 'string' || !UUID.test(employeeId)) return apiResponse.badRequest(res, 'id must be a UUID');
  if (!(await checkReportRateLimit(companyId, `payslip-history:u:${user.id}`, INTERACTIVE_REPORT_LIMIT))) {
    log.warn('Payslip history rate limit exceeded', { companyId, userId: user.id }, 'payslips');
    return apiResponse.tooManyRequests(res, 'Too many payslip requests. Please try again shortly.');
  }
  const entries = await listEmployeePayslips(companyId, employeeId);
  if (!entries) return apiResponse.notFound(res, 'Employee');
  return apiResponse.success(res, entries);
}

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)))));
