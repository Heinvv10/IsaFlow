/**
 * GET  /api/payroll/leave — list leave requests
 * POST /api/payroll/leave — create a leave request
 *
 * GET query params: employeeId, status, month, year
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  listLeaveRequests,
  createLeaveRequest,
} from '@/modules/accounting/services/payroll/payrollLeaveService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { employeeId, status, month, year } = req.query as Record<string, string | undefined>;
    const requests = await listLeaveRequests(companyId, {
      employeeId: employeeId ?? undefined,
      status: status ?? undefined,
      month: month ? Number(month) : undefined,
      year: year ? Number(year) : undefined,
    });
    return apiResponse.success(res, requests);
  }

  if (req.method === 'POST') {
    const { employeeId, leaveTypeId, startDate, endDate, days, reason } =
      req.body as Record<string, unknown>;

    if (!employeeId || !leaveTypeId || !startDate || !endDate || days == null) {
      return apiResponse.badRequest(
        res,
        'employeeId, leaveTypeId, startDate, endDate, days are required',
      );
    }

    const request = await createLeaveRequest(companyId, {
      employeeId: String(employeeId),
      leaveTypeId: String(leaveTypeId),
      startDate: String(startDate),
      endDate: String(endDate),
      days: Number(days),
      reason: reason ? String(reason) : undefined,
    });
    return apiResponse.created(res, request);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
