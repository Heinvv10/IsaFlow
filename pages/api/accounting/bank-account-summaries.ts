/**
 * Bank Account Summaries API (WP1 "Truthful numbers", PR-B)
 * GET /api/accounting/bank-account-summaries
 * One summary per leaf bank account of the company: line counts by bucket, the ledger balance as at today (SAST),
 * and the latest statement with its difference (bankAccountSummaryService / bankAccountSummarySql). Takes no query
 * parameters. Read-only: plain SELECTs, no row locks. GET only (405 otherwise); a failed read throws, so it is a 500.
 * withWriteAccess matches the sibling bank GET routes; it passes GET straight through.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { getBankAccountSummaries } from '@/modules/accounting/services/bank/bankAccountSummaryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  return apiResponse.success(res, await getBankAccountSummaries(companyId));
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
