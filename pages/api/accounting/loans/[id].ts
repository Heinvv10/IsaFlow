/**
 * Single Loan API
 * GET    — get loan detail
 * PATCH  — update loan (status, glAccountId, reference, description,
 *          plus financial terms when no GL postings exist or ?force=true)
 * DELETE — soft-delete loan (sets status='closed'); refuses if GL postings
 *          unless ?force=true
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import { getLoanById, updateLoan, deleteLoan, type LoanUpdateInput } from '@/modules/accounting/services/loans/loanService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const loanId = String(req.query.id);
  const force = req.query.force === 'true';

  if (!UUID_RE.test(loanId)) return apiResponse.notFound(res, 'Loan', loanId);

  if (req.method === 'GET') {
    const loan = await getLoanById(companyId, loanId);
    if (!loan) return apiResponse.notFound(res, 'Loan', loanId);
    return apiResponse.success(res, loan);
  }

  if (req.method === 'PATCH') {
    const body = req.body as LoanUpdateInput;
    try {
      const loan = await updateLoan(companyId, loanId, body, { force });
      if (!loan) return apiResponse.notFound(res, 'Loan', loanId);
      return apiResponse.success(res, loan);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Update failed';
      return apiResponse.badRequest(res, msg);
    }
  }

  if (req.method === 'DELETE') {
    try {
      const ok = await deleteLoan(companyId, loanId, { force });
      if (!ok) return apiResponse.notFound(res, 'Loan', loanId);
      return apiResponse.success(res, { deleted: true, loanId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      return apiResponse.badRequest(res, msg);
    }
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
