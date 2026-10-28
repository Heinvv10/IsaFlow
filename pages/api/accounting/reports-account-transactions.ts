/**
 * Account Transactions Report API
 * GET /api/accounting/reports-account-transactions?account_code=1110&period_start=&period_end=
 * Optional cost_centre_id (either level: cc1 OR cc2), business_unit_id, and the
 * explicit levels cc1_id / cc2_id (the Budget vs Actual drill, budgets P3 §2.6)
 * are cumulative. The BvA drill also sends `documents=1` (each row's source
 * document) and `sign=natural` (balances signed by account type, as the BvA
 * Actual is); no other value is accepted, and no other drill sends them.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { UUID_RE } from '@/lib/validation';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { hasNul, NUL_MESSAGE } from '@/lib/validation';
import { isLedgerDate, LEDGER_DATE_MESSAGE } from '@/modules/accounting/services/gl/ledgerDateRange';
import { LedgerAccountNotFoundError } from '@/modules/accounting/services/gl/ledgerErrors';
import { getAccountTransactions } from '@/modules/accounting/services/reports/transactionReportingService';
import type { AccountTransactionsOptions } from '@/modules/accounting/services/gl/accountTransactionsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  if (hasNul(req.query)) return apiResponse.badRequest(res, NUL_MESSAGE);
  const { companyId } = req as CompanyAuthedRequest;
  const costCentreId = req.query.cost_centre_id;
  if (costCentreId !== undefined && (typeof costCentreId !== 'string' || !UUID_RE.test(costCentreId))) {
    return apiResponse.badRequest(res, 'cost_centre_id must be a valid UUID');
  }
  const businessUnitId = req.query.business_unit_id;
  if (businessUnitId !== undefined && (typeof businessUnitId !== 'string' || !UUID_RE.test(businessUnitId))) {
    return apiResponse.badRequest(res, 'business_unit_id must be a valid UUID');
  }
  const opts: AccountTransactionsOptions = {};
  for (const [param, key] of [['cc1_id', 'cc1Id'], ['cc2_id', 'cc2Id']] as const) {
    const value = req.query[param];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !UUID_RE.test(value)) return apiResponse.badRequest(res, `${param} must be a valid UUID`);
    opts[key] = value;
  }
  for (const [param, expected, key] of [['documents', '1', 'documents'], ['sign', 'natural', 'naturalSign']] as const) {
    const value = req.query[param];
    if (value === undefined) continue;
    if (value !== expected) return apiResponse.badRequest(res, `${param} must be ${expected}`);
    opts[key] = true;
  }

  try {
    const { account_code, period_start, period_end } = req.query;
    if (typeof account_code !== 'string' || !account_code || !period_start || !period_end) {
      return apiResponse.badRequest(res, 'account_code, period_start, and period_end required');
    }
    if (!isLedgerDate(period_start) || !isLedgerDate(period_end)) {
      return apiResponse.badRequest(res, `period_start and period_end ${LEDGER_DATE_MESSAGE}`);
    }
    if (period_start > period_end) return apiResponse.badRequest(res, 'period_start must not be after period_end');
    const report = await getAccountTransactions(companyId,
      String(account_code), String(period_start), String(period_end), costCentreId, businessUnitId, opts
    );
    return apiResponse.success(res, report);
  } catch (err) {
    if (err instanceof LedgerAccountNotFoundError) return apiResponse.notFound(res, 'Account');
    log.error('Account transactions report failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to generate account transactions report');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
