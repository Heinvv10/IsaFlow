/**
 * General Ledger Report API
 * GET /api/accounting/reports-general-ledger?period_start=&period_end=
 *
 * Returns every account carrying activity or an opening balance in the period.
 * Replaces the client-side fan-out over reports-account-transactions, which
 * issued one request per account and was therefore capped at 20 (issue #287).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getGeneralLedgerReport } from '@/modules/accounting/services/gl/generalLedgerReportService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  try {
    const { period_start, period_end } = req.query;
    if (!period_start || !period_end) {
      return apiResponse.badRequest(res, 'period_start and period_end required');
    }
    const accounts = await getGeneralLedgerReport(
      companyId,
      String(period_start),
      String(period_end)
    );
    return apiResponse.success(res, { accounts });
  } catch (err) {
    log.error('General ledger report failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to generate general ledger report');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
