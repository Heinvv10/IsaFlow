/**
 * Budget vs Actual Export API
 * GET — export budget vs actual report as CSV
 *
 * Built from the SAME result as the screen (loadBudgetVsActualReport →
 * getBudgetVariance) and rendered by the pure budgetVsActualCsv: no SQL of its
 * own, so the CSV cannot drift from the report (budgets P0, D3/D14).
 *
 * Query params:
 *   period       current | ytd | full_year   (default: ytd; anything else is a 400)
 *   fiscal_year  optional financial-year label (ytd and full_year); 404 if no year carries it, 400 if not a label
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { localISODate } from '@/lib/dateUtils';
import { BudgetReportYearError } from '@/modules/accounting/services/reports/budgetReportYear';
import { BudgetPeriodError } from '@/modules/accounting/services/reports/budgetWindowService';
import { loadBudgetVsActualReport } from '@/modules/accounting/services/reports/budgetVsActualReport';
import { budgetVsActualCsv } from '@/modules/accounting/services/reports/budgetVsActualCsv';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { result } = await loadBudgetVsActualReport(companyId, req.query.period, req.query.fiscal_year);
    const filename = `budget-vs-actual-${localISODate()}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(budgetVsActualCsv(result));
  } catch (err) {
    if (err instanceof BudgetPeriodError) return apiResponse.badRequest(res, err.message);
    if (err instanceof BudgetReportYearError) {
      return err.unknown ? apiResponse.notFound(res, 'Financial year', String(err.label)) : apiResponse.badRequest(res, err.message);
    }
    // Anything else is a real failure: rethrown, withErrorHandler answers 500 and the request rolls back.
    log.error('Failed to export budget vs actual report', { error: err instanceof Error ? err.message : String(err) }, 'accounting-api');
    throw err;
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
