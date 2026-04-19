/**
 * Single Loan API
 * GET   — get loan detail
 * PATCH — update (status, glAccountId, reference, description)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import { getLoanById, updateLoan, type LoanUpdateInput } from '@/modules/accounting/services/loans/loanService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const loanId = String(req.query.id);

  if (req.method === 'GET') {
    const loan = await getLoanById(companyId, loanId);
    if (!loan) return apiResponse.notFound(res, 'Loan', loanId);
    return apiResponse.success(res, loan);
  }

  if (req.method === 'PATCH') {
    const body = req.body as LoanUpdateInput;
    const loan = await updateLoan(companyId, loanId, body);
    if (!loan) return apiResponse.notFound(res, 'Loan', loanId);
    return apiResponse.success(res, loan);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
