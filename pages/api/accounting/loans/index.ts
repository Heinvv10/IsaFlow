/**
 * Loans API
 * GET  — list loans (?status=, ?product=)
 * POST — create loan
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  listLoans,
  createLoan,
  type LoanCreateInput,
  type ListLoansFilter,
} from '@/modules/accounting/services/loans/loanService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const filter: ListLoansFilter = {};
    if (req.query.status) filter.status = String(req.query.status) as ListLoansFilter['status'];
    if (req.query.product) filter.product = String(req.query.product);
    const loans = await listLoans(companyId, filter);
    return apiResponse.success(res, loans);
  }

  if (req.method === 'POST') {
    const body = req.body as LoanCreateInput;
    const loan = await createLoan(companyId, body);
    return apiResponse.created(res, loan);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
