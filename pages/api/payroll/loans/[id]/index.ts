/**
 * GET /api/payroll/loans/:id  - loan + schedule + payments
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { getLoan, LoanNotFoundError } from '@/modules/accounting/services/payroll/payrollLoanService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing loan id');

  try {
    const result = await getLoan(companyId, id);
    return apiResponse.success(res, result);
  } catch (err) {
    if (err instanceof LoanNotFoundError) return apiResponse.notFound(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(handler));
