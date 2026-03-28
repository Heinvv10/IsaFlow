/**
 * Account Transactions Report API
 * GET /api/accounting/reports-account-transactions?account_code=1110&period_start=&period_end=
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getAccountTransactions } from '@/modules/accounting/services/transactionReportingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyApiRequest;
  try {
    const { account_code, period_start, period_end } = req.query;
    if (!account_code || !period_start || !period_end) {
      return apiResponse.badRequest(res, 'account_code, period_start, and period_end required');
    }
    const report = await getAccountTransactions(companyId,
      String(account_code), String(period_start), String(period_end)
    );
    return apiResponse.success(res, report);
  } catch (err) {
    log.error('Account transactions report failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to generate account transactions report');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
