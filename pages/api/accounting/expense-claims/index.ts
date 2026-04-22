/**
 * /api/accounting/expense-claims
 *   GET  — list claims (filter by employee_id, status)
 *   POST — create a new draft claim
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import {
  listClaims,
  createClaim,
  type ExpenseClaimLine,
} from '@/modules/accounting/services/expense/expenseClaimService';

interface CreateBody {
  employeeId?: string;
  claimDate?: string;
  title?: string;
  description?: string;
  lines?: ExpenseClaimLine[];
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method === 'GET') {
    const employeeId = req.query.employeeId as string | undefined;
    const status = req.query.status as string | undefined;
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '100'), 10)));
    const claims = await listClaims(companyId, { employeeId, status, limit });
    return apiResponse.success(res, { claims, total: claims.length });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as CreateBody;
    if (!body.employeeId) return apiResponse.badRequest(res, 'employeeId is required');
    const claim = await createClaim({
      companyId,
      employeeId: body.employeeId,
      claimDate: body.claimDate,
      title: body.title ?? null,
      description: body.description ?? null,
      createdBy: req.user?.id ?? null,
      lines: body.lines,
    });
    return apiResponse.created(res, { claim });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
