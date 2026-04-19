/**
 * Loan GL Postings API
 * GET  — list GL postings for a loan
 * POST — post journals for a given period (body: { period: number })
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  getLoanGlPostings,
  postPeriodJournals,
} from '@/modules/accounting/services/loans/loanGlPostingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const loanId = String(req.query.id);

  if (req.method === 'GET') {
    const postings = await getLoanGlPostings(companyId, loanId);
    return apiResponse.success(res, postings);
  }

  if (req.method === 'POST') {
    const { period } = req.body as { period?: number };
    if (!period || period <= 0) return apiResponse.badRequest(res, 'period (positive integer) is required');
    const result = await postPeriodJournals(companyId, loanId, period, userId);
    return apiResponse.created(res, result);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
