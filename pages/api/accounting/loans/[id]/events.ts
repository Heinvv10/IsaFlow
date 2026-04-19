/**
 * Loan Events API
 * GET  — list events for a loan
 * POST — add event (LUMP, SKIP, RESTRUCTURE, WRITEOFF)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import { addLoanEvent, getLoanEvents, type LoanEventInput } from '@/modules/accounting/services/loans/loanService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const loanId = String(req.query.id);

  if (req.method === 'GET') {
    const events = await getLoanEvents(companyId, loanId);
    return apiResponse.success(res, events);
  }

  if (req.method === 'POST') {
    const body = req.body as LoanEventInput;
    const event = await addLoanEvent(companyId, loanId, userId, body);
    return apiResponse.created(res, event);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
