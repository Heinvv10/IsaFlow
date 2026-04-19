/**
 * Loan Compliance API
 * GET  — list prior assessments (history)
 * POST — run a new assessment (body: { asOfDate?: YYYY-MM-DD })
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  assessLoan,
  listAssessments,
} from '@/modules/accounting/services/loans/loanComplianceService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const loanId = String(req.query.id);

  if (req.method === 'GET') {
    const history = await listAssessments(companyId, loanId);
    return apiResponse.success(res, history);
  }

  if (req.method === 'POST') {
    const { asOfDate } = req.body as { asOfDate?: string };
    const today = asOfDate ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
      return apiResponse.badRequest(res, 'asOfDate must be YYYY-MM-DD');
    }
    const assessment = await assessLoan(companyId, loanId, userId, today);
    return apiResponse.created(res, assessment);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
