/**
 * Budget vs Actual Report API
 * GET /api/accounting/reports-budget-vs-actual?period=current|ytd|full_year[&fiscal_year=2027]
 * `period` defaults to ytd; any other value is a 400. `fiscal_year` (optional, ytd and
 * full_year only) is a financial-year label from the registry: 404 when no year carries it,
 * 400 when it is not a label.
 * Sage equivalent: Reports > Budget vs Actual
 *
 * Every figure comes from getBudgetVariance through loadBudgetVsActualReport, the
 * same path as the CSV export, MCP budget_variance and the statement Budget column:
 * `lines` (the row model) and `sections` (Revenue / Expenses / Net profit). Read-only:
 * viewer roles may open it (contract decision 15).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { localISODate } from '@/lib/dateUtils';
import { BudgetReportYearError, reportYearOptions } from '@/modules/accounting/services/reports/budgetReportYear';
import { BudgetPeriodError } from '@/modules/accounting/services/reports/budgetWindowService';
import { loadBudgetVsActualReport } from '@/modules/accounting/services/reports/budgetVsActualReport';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { window, result } = await loadBudgetVsActualReport(companyId, req.query.period, req.query.fiscal_year);
    const { startDate, endDate, fiscalYear, notStarted } = window;

    const report = {
      // A year that has not started has no window to name; the page says when it starts.
      period: notStarted ? 'not started' : `${startDate} to ${endDate}`,
      ...(notStarted ? { not_started: true, starts_on: startDate } : {}),
      lines: result.lines,
      sections: result.sections,
      posted_through: result.postedThrough,
    };

    return apiResponse.success(res, {
      report, fiscal_year: fiscalYear.fiscalYear, years: await reportYearOptions(companyId, localISODate()),
    });
  } catch (err) {
    if (err instanceof BudgetPeriodError) return apiResponse.badRequest(res, err.message);
    if (err instanceof BudgetReportYearError) {
      return err.unknown ? apiResponse.notFound(res, 'Financial year', String(err.label)) : apiResponse.badRequest(res, err.message);
    }
    // Anything else is a real failure: rethrown, withErrorHandler answers 500 and the request rolls back.
    log.error('Failed to generate budget vs actual report', { error: err, module: 'accounting' });
    throw err;
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
