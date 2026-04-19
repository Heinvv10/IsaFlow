/**
 * Loan Period Close API
 * POST — close the loan period, post reclass journals, lock the period.
 * Route: /api/accounting/loan-periods/[yyyymm]/close
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  closeLoanPeriod,
  isPeriodLocked,
} from '@/modules/accounting/services/loans/loanPeriodCloseService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const yyyymm = String(req.query.yyyymm);

  if (!/^\d{6}$/.test(yyyymm)) {
    return apiResponse.badRequest(res, 'yyyymm must be a 6-digit string (e.g. 202604)');
  }

  if (req.method === 'GET') {
    const locked = await isPeriodLocked(companyId, yyyymm);
    return apiResponse.success(res, { yyyymm, locked });
  }

  if (req.method === 'POST') {
    const result = await closeLoanPeriod(companyId, yyyymm, userId);
    return apiResponse.created(res, result);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
