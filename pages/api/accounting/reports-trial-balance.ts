/**
 * Trial Balance Report API
 * GET /api/accounting/reports-trial-balance?fiscal_period_id=...&business_unit_id=...
 *
 * Response shape: `TrialBalanceReport` plus `comparePeriodId` —
 *   { fiscalPeriodId, periodStart, periodEnd, fiscalYearStart, rows,
 *     accountCount, totalDebit, totalCredit, difference, balanced }
 *
 * The canonical key for the account lines is **`rows`** (not `accounts`).
 * Frontend reads `data.rows`; any external consumer must use `data.rows`.
 *
 * `difference` and `balanced` are computed in the service and are authoritative.
 * A consumer that recomputes them can disagree with the report it is displaying —
 * that is how a 7-of-118-account trial balance got stamped "Balanced".
 *
 * `?include_zero_balances=true` keeps accounts whose balance and movement both
 * net to zero. Accounts that carry a balance but did not move are ALWAYS
 * returned, with periodDebit/periodCredit at zero.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withFlowMeter } from '@/lib/billing/withFlowMeter';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { log } from '@/lib/logger';
import { getTrialBalance, getTrialBalanceReport } from '@/modules/accounting/services/gl/trialBalanceService';
import { isUuidParam } from '@/lib/validation';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const fiscalPeriodId = req.query.fiscal_period_id;
  const costCentreId = req.query.cost_centre_id;
  const businessUnitId = req.query.business_unit_id;
  const comparePeriodId = req.query.compare_period_id;
  if (fiscalPeriodId === undefined) {
    return apiResponse.badRequest(res, 'fiscal_period_id is required');
  }
  if (!isUuidParam(fiscalPeriodId)) {
    return apiResponse.badRequest(res, 'fiscal_period_id must be a valid UUID');
  }
  if (costCentreId !== undefined && !isUuidParam(costCentreId)) {
    return apiResponse.badRequest(res, 'cost_centre_id must be a valid UUID');
  }
  if (businessUnitId !== undefined && !isUuidParam(businessUnitId)) {
    return apiResponse.badRequest(res, 'business_unit_id must be a valid UUID');
  }
  if (comparePeriodId !== undefined && !isUuidParam(comparePeriodId)) {
    return apiResponse.badRequest(res, 'compare_period_id must be a valid UUID');
  }

  try {
    const includeZeroBalances = req.query.include_zero_balances === 'true';
    const report = await getTrialBalanceReport(companyId, fiscalPeriodId, {
      costCentreId: costCentreId || undefined,
      businessUnitId,
      includeZeroBalances,
    });

    if (comparePeriodId) {
      const priorRows = await getTrialBalance(companyId, comparePeriodId, costCentreId || undefined, {
        businessUnitId,
        includeZeroBalances,
      });
      const priorMap = new Map(priorRows.map(r => [r.accountCode, r]));
      for (const row of report.rows) {
        const prior = priorMap.get(row.accountCode);
        row.priorDebitBalance = prior?.debitBalance ?? 0;
        row.priorCreditBalance = prior?.creditBalance ?? 0;
      }
    }

    // `difference` / `balanced` come from the service — see getTrialBalanceReport.
    // Do NOT recompute them here or in any consumer.
    return apiResponse.success(res, { ...report, comparePeriodId });
  } catch (err) {
    log.error('Failed to get trial balance', { error: err }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to get trial balance');
  }
}

 
export default withAuth(
  withErrorHandler(
    withWriteAccess(
      withFlowMeter('report.tb', getFlowCost('report.tb'))(handler),
    ),
  ),
);
