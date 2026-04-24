/**
 * POST /api/payroll/loans/:id/close
 * Body: { status: 'settled' | 'written_off' | 'cancelled' }
 * Transitions an active loan to a closed status. Not reopenable — create a
 * new loan if needed. Admin/manager only.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withCsrf,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import {
  closeLoan,
  LoanNotFoundError,
  LoanClosedError,
} from '@/modules/accounting/services/payroll/payrollLoanService';

const Body = z.object({ status: z.enum(['settled', 'written_off', 'cancelled']) }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }
  const { companyId, user } = req as CompanyAuthedRequest;
  const role = String((user as { role?: string }).role ?? '');
  if (!['super_admin', 'admin', 'manager'].includes(role)) {
    return apiResponse.forbidden(res, 'Only admins and managers can close a loan');
  }
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing loan id');

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, 'status required');

  try {
    await closeLoan(companyId, id, parsed.data.status, user.id);
    return apiResponse.success(res, { closed: true, status: parsed.data.status });
  } catch (err) {
    if (err instanceof LoanNotFoundError) return apiResponse.notFound(res, err.message);
    if (err instanceof LoanClosedError) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
