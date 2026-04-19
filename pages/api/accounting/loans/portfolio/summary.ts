/**
 * Loan Portfolio Summary API
 * GET — portfolio KPIs: total outstanding, weighted rate, current portion, etc.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getPortfolioSummary } from '@/modules/accounting/services/loans/loanScheduleService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const summary = await getPortfolioSummary(companyId);
    return apiResponse.success(res, summary);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withAuth>[0]));
