import { fmtDate } from '@/lib/fmtDate';
import { getIndirectCashFlow } from '@/modules/accounting/services/reports/cashFlowIndirectService';
/**
 * Cash Flow Statement API
 * GET /api/accounting/reports-cash-flow?start_date=&end_date=
 * Sage equivalent: Reports > Cash Flow Statement
 *
 * Derives cash flow from GL journal lines (cashFlowIndirectService): net income, then the movement of every
 * other non-cash account (receivables, payables, VAT control, inventory, prepayments, accumulated depreciation, ...)
 * in operating; fixed assets etc. in investing; equity, loans and retained earnings in financing. Closing cash is
 * the ledger's cash balance by construction.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';

const COST_CENTRE_REFUSAL = 'Cash flow cannot be reported by cost centre: cash is held in bank accounts, not by cost centre';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req;

  // Deliberately BEFORE the period is read or validated: a request naming a cost centre is refused whatever its dates say.
  // No cost-centre cash flow: cash is held in bank accounts, which no cost centre owns. Refused, not ignored.
  if (req.query.cost_centre || req.query.cost_centre_id) return apiResponse.badRequest(res, COST_CENTRE_REFUSAL);

  try {
    // Accept both start_date/end_date (legacy) and period_start/period_end (aligned
     // with income-statement/balance-sheet endpoints)
    const { start_date, end_date, period_start, period_end } = req.query;

    const startDate = (period_start as string) || (start_date as string) || fmtDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const endDate = (period_end as string) || (end_date as string) || new Date().toISOString().slice(0, 10);

    const cf = await getIndirectCashFlow(companyId, startDate, endDate);

    const report = {
      period_start: cf.periodStart,
      period_end: cf.periodEnd,
      opening_cash: cf.openingCash,
      sections: cf.sections,
      net_change: cf.netChange,
      closing_cash: cf.closingCash,
    };

    return apiResponse.success(res, { report });
  } catch (err) {
    log.error('Failed to generate cash flow statement', { error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to generate cash flow statement');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
