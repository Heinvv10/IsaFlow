/**
 * Bank Transactions Report API
 * GET /api/accounting/reports-bank-transactions?period_start=&period_end=&account_code=1110
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { getBankTransactions } from '@/modules/accounting/services/reports/transactionReportingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyApiRequest;
  try {
    const { period_start, period_end, account_code } = req.query;
    if (!period_start || !period_end) return apiResponse.badRequest(res, 'period_start and period_end required');
    const report = await getBankTransactions(companyId,
      String(period_start), String(period_end),
      account_code ? String(account_code) : undefined
    );
    return apiResponse.success(res, report);
  } catch (err) {
    log.error('Bank transactions report failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to generate bank transactions report');
  }
}

 
export default withCompany(withErrorHandler(withWriteAccess(handler)));
