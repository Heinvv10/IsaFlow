/**
 * GET    /api/payroll/leave/[id] — get leave request
 * PUT    /api/payroll/leave/[id] — approve / reject / cancel
 * DELETE /api/payroll/leave/[id] — delete pending request
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  getLeaveRequest,
  updateLeaveRequest,
  deleteLeaveRequest,
} from '@/modules/accounting/services/payroll/payrollLeaveService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id);

  if (!UUID_RE.test(id)) return apiResponse.notFound(res, 'Leave request not found');

  if (req.method === 'GET') {
    const request = await getLeaveRequest(id, companyId);
    if (!request) return apiResponse.notFound(res, 'Leave request not found');
    return apiResponse.success(res, request);
  }

  if (req.method === 'PUT') {
    const { status, approvedBy } = req.body as Record<string, unknown>;
    if (!status || !['approved', 'rejected', 'cancelled'].includes(String(status))) {
      return apiResponse.badRequest(res, 'status must be approved, rejected, or cancelled');
    }
    const updated = await updateLeaveRequest(id, companyId, {
      status: String(status) as 'approved' | 'rejected' | 'cancelled',
      approvedBy: approvedBy ? String(approvedBy) : undefined,
    });
    return apiResponse.success(res, updated);
  }

  if (req.method === 'DELETE') {
    await deleteLeaveRequest(id, companyId);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
