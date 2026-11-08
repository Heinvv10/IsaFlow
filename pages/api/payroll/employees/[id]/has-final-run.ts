/**
 * GET /api/payroll/employees/[id]/has-final-run — { hasFinalRun: boolean }: does the employee already have a line on
 * a final (R-035 cleared) pay run? For the profile's "Ready to pay" copy ("first" or "next" pay run). A boolean only,
 * so it never carries a figure; payroll-detail roles only; another company's employee is 404; no-store; rate-limited per user.
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
import { employeeHasFinalRun } from '@/modules/accounting/services/payroll/employeeFinalRun';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const employeeId = req.query.id;
  if (typeof employeeId !== 'string' || !UUID.test(employeeId)) return apiResponse.badRequest(res, 'id must be a UUID');
  if (!(await checkReportRateLimit(companyId, `has-final-run:u:${user.id}`, INTERACTIVE_REPORT_LIMIT))) {
    log.warn('Final-run check rate limit exceeded', { companyId, userId: user.id }, 'has-final-run');
    return apiResponse.tooManyRequests(res, 'Too many requests. Please try again shortly.');
  }
  const hasFinalRun = await employeeHasFinalRun(companyId, employeeId);
  if (hasFinalRun === null) return apiResponse.notFound(res, 'Employee');
  return apiResponse.success(res, { hasFinalRun });
}

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)))));
