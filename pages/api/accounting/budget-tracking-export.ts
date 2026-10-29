/**
 * GET /api/accounting/budget-tracking-export?format=csv|xlsx&<the reports-budget-tracking query>
 * (budgets P3 spec §2.8)
 *
 * The SAME engine call and the SAME row adapter the page renders
 * (`buildBudgetTrackingReport` → `statementRows/budgetTrackingRows`), then
 * serialised (`tracking/trackingExport`): no SQL and no arithmetic of its own,
 * so the file cannot disagree with the screen. Columns: Code, Account, Band,
 * Actual, Budget, Var R, Var %, Favourable, Projected FY, FY budget, Proj. var
 * R, Unallocated budget; absent is an empty cell. Read-only (contract
 * decision 15): no withWriteAccess.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { respondTrackingError } from '@/lib/budgetTrackingResponse';
import { getCompanyName } from '@/modules/accounting/services/reports/companyName';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';
import { parseTrackingQuery } from '@/modules/accounting/services/budgets/tracking/trackingQuery';
import { trackingCsv, trackingXlsx } from '@/modules/accounting/services/budgets/tracking/trackingExport';

const Format = z.preprocess((v) => (v === '' || v === undefined ? 'csv' : v), z.enum(['csv', 'xlsx']));
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;

  if (!(await checkReportRateLimit(companyId, 'budget-tracking-export'))) {
    log.warn('Budget tracking export rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many report requests. Please try again shortly.');
  }

  const format = Format.safeParse(req.query.format);
  if (!format.success) return apiResponse.badRequest(res, 'format must be csv or xlsx');
  const parsed = parseTrackingQuery(req.query);
  if (!parsed.ok) return apiResponse.badRequest(res, parsed.message, parsed.fieldErrors);

  try {
    const report = await buildBudgetTrackingReport(companyId, parsed.params);
    const companyName = await getCompanyName(companyId);
    const filename = `budget-vs-actual-${report.window.startDate}-${report.window.endDate}.${format.data}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (format.data === 'xlsx') {
      res.setHeader('Content-Type', XLSX_MIME);
      return res.status(200).send(await trackingXlsx(report, companyName));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.status(200).send(trackingCsv(report, companyName));
  } catch (err) {
    if (respondTrackingError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(handler as never));
