/**
 * Budget years API (read-only since budgets P2 PR-D: the workspace writes through
 * budget-grid/save and the version routes).
 * GET — the budgets of a financial year (label), with the year's months and the
 *       years a budget can be set for. An optional `versionId` reads that version
 *       (default the year's primary); a version of another year or tenant is 404.
 *       `years_only=1` answers only the year and the year list, without reading
 *       the budgets: what the workspace's year select needs.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getBudgetsForYear } from '@/modules/accounting/services/core/budgetService';
import { parseYearLabel } from '@/modules/accounting/services/core/budgetMonths';
import { listBudgetYears, toBudgetYearInfo } from '@/modules/accounting/services/core/budgetYears';
import { fiscalYearForDate, getFiscalYear } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { localISODate } from '@/lib/dateUtils';
import { isUuidParam } from '@/lib/validation';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const { companyId } = req as CompanyAuthedRequest;

  const today = localISODate();
  const raw = req.query.fiscal_year;
  // The page's first load has no year yet: absent and empty both mean "the current year".
  const requested = raw === undefined || raw === '' ? null : parseYearLabel(raw);
  if (raw !== undefined && raw !== '' && requested === null) {
    return apiResponse.badRequest(res, 'fiscal_year must be a year label such as 2027');
  }
  const yearsOnly = req.query.years_only;
  if (yearsOnly !== undefined && yearsOnly !== '1') return apiResponse.badRequest(res, 'years_only must be 1 when given');
  const versionId = req.query.versionId;
  if (versionId !== undefined && !isUuidParam(versionId)) return apiResponse.badRequest(res, 'versionId must be a version id');
  const fiscalYear = requested ?? (await fiscalYearForDate(companyId, today)).fiscalYear;
  const found = await getFiscalYear(companyId, fiscalYear);
  if (!found) return apiResponse.notFound(res, 'Financial year', String(fiscalYear));
  // Anything else that fails is a real failure: withErrorHandler answers 500.
  const year = toBudgetYearInfo(found);
  if (yearsOnly === '1') {
    return apiResponse.success(res, { fiscalYear, year, years: await listBudgetYears(companyId, today) });
  }
  // One after the other: both run savepoints on the one request connection, and
  // savepoints there must nest, never interleave (src/lib/neon/transaction.ts).
  let items;
  try {
    items = await getBudgetsForYear(companyId, found, versionId);
  } catch (err) {
    if (respondBudgetVersionError(res, err)) return;
    throw err;
  }
  const years = await listBudgetYears(companyId, today);
  return apiResponse.success(res, { items, fiscalYear, year, years });
}

export default withAuth(withErrorHandler(handler));
