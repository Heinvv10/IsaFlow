/**
 * GET /api/accounting/income-statement-pdf
 * The Income Statement as a PDF download: the query contract of
 * income-statement-xlsx, with the report rate limit a PDF render earns. A
 * `group_by` is refused: see incomeStatementPdf.ts.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { localISODate } from '@/lib/dateUtils';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { isRealCalendarDate, isUuidParam } from '@/lib/validation';
import { getCompanyDetailsFromCompany } from '@/modules/accounting/services/core/pdfShared';
import { isDimensionGroupBy } from '@/modules/accounting/services/reports/dimensionPnlColumns';
import { getIncomeStatement } from '@/modules/accounting/services/reports/financialReportingService';
import { buildIncomeStatementPdf, incomeStatementScopeLabel } from '@/modules/accounting/services/reports/incomeStatementPdf';

const isDateParam = (value: unknown): value is string => typeof value === 'string' && isRealCalendarDate(value);

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  const { companyId } = req as unknown as CompanyAuthedRequest;
  const { period_start: start, period_end: end, cost_centre_id: ccId, business_unit_id: businessUnitId, group_by: groupBy } = req.query;

  if (!isDateParam(start) || !isDateParam(end)) {
    return apiResponse.badRequest(res, 'period_start and period_end are required, as YYYY-MM-DD');
  }
  if (start > end) return apiResponse.badRequest(res, 'period_start must be on or before period_end');
  if (ccId !== undefined && !isUuidParam(ccId)) {
    return apiResponse.badRequest(res, 'cost_centre_id must be a valid UUID');
  }
  if (businessUnitId !== undefined && !isUuidParam(businessUnitId)) {
    return apiResponse.badRequest(res, 'business_unit_id must be a valid UUID');
  }
  if (groupBy !== undefined) {
    return apiResponse.badRequest(res, isDimensionGroupBy(groupBy)
      ? 'Group-by is exported to Excel only'
      : 'group_by must be one of cc1, cc2, bu');
  }

  if (!(await checkReportRateLimit(companyId, 'income-statement-pdf'))) {
    log.warn('Income statement PDF rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many report exports. Please try again shortly.');
  }

  // One after the other: every read runs on the request's one pg client.
  const company = await getCompanyDetailsFromCompany(companyId);
  const report = await getIncomeStatement(companyId, start, end, { costCentreId: ccId, businessUnitId });
  const scope = await incomeStatementScopeLabel(companyId, ccId, businessUnitId);
  const pdf = await buildIncomeStatementPdf(report, company, { scope, generatedOn: localISODate() });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="income-statement-${start}-to-${end}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdf);
}

export default withAuth(withErrorHandler(handler));
