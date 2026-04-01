/**
 * Trial Balance Report API
 * GET /api/accounting/reports-trial-balance?fiscal_period_id=...
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getTrialBalance } from '@/modules/accounting/services/journalEntryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const fiscalPeriodId = req.query.fiscal_period_id as string;
    const costCentreId = req.query.cost_centre_id as string | undefined;
    const comparePeriodId = req.query.compare_period_id as string | undefined;
    if (!fiscalPeriodId) {
      return apiResponse.badRequest(res, 'fiscal_period_id is required');
    }

    const rows = await getTrialBalance(companyId,fiscalPeriodId, costCentreId || undefined);
    const totalDebit = rows.reduce((sum, r) => sum + r.debitBalance, 0);
    const totalCredit = rows.reduce((sum, r) => sum + r.creditBalance, 0);

    if (comparePeriodId) {
      const priorRows = await getTrialBalance(companyId,comparePeriodId, costCentreId || undefined);
      const priorMap = new Map(priorRows.map(r => [r.accountCode, r]));
      for (const row of rows) {
        const prior = priorMap.get(row.accountCode);
        row.priorDebitBalance = prior?.debitBalance ?? 0;
        row.priorCreditBalance = prior?.creditBalance ?? 0;
      }
    }

    return apiResponse.success(res, {
      fiscalPeriodId,
      comparePeriodId,
      rows,
      totalDebit,
      totalCredit,
    });
  } catch (err) {
    log.error('Failed to get trial balance', { error: err }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to get trial balance');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
