/**
 * GET  /api/payroll/leave/types — list active leave types for company
 * POST /api/payroll/leave/types — create a new leave type
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { listLeaveTypes, createLeaveType } from '@/modules/accounting/services/payroll/payrollLeaveService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const types = await listLeaveTypes(companyId);
    return apiResponse.success(res, types);
  }

  if (req.method === 'POST') {
    const { name, bceaType, accrualRule, accrualDays, maxCarryOver, isPaid } =
      req.body as Record<string, unknown>;

    if (!name || !accrualRule) {
      return apiResponse.badRequest(res, 'name and accrualRule are required');
    }

    const leaveType = await createLeaveType(companyId, {
      name: String(name),
      bceaType: bceaType ? String(bceaType) : null,
      accrualRule: String(accrualRule),
      accrualDays: Number(accrualDays) || 0,
      maxCarryOver: maxCarryOver != null ? Number(maxCarryOver) : null,
      isPaid: isPaid !== false,
    });
    return apiResponse.created(res, leaveType);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
