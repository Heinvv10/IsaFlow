/**
 * Financial Ratios Report API
 * GET /api/accounting/reports-ratios?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Every figure comes from the shared GL classification resolver. Previously
 * this endpoint fabricated the liquidity inputs — currentAssets = assets * 0.6,
 * currentLiabilities = liabilities * 0.5, inventory = assets * 0.1 and so on —
 * which pinned the current ratio at 1.2 and the quick ratio at 1.0 for every
 * company. It also filtered cost of sales on `account_type = 'cost_of_sales'`,
 * a value the gl_accounts CHECK constraint forbids, so cost of sales was always
 * zero and gross margin always 100%.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import {
  getFinancialFigures,
  toFinancialData,
  unclassifiedWarning,
  inventoryWarning,
} from '@/modules/accounting/services/gl/financialFiguresService';
import { calculateFinancialRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import type { CompanyAuthedRequest } from '@/lib/auth/withAuth';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const companyId = (req as CompanyAuthedRequest).companyId;

  const to = (req.query.to as string) || new Date().toISOString().split('T')[0]!;
  // Slice the year off the string rather than round-tripping through Date —
  // `new Date('2026-01-01').getFullYear()` is timezone-dependent.
  const from = (req.query.from as string) || `${to.slice(0, 4)}-01-01`;

  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return apiResponse.badRequest(res, 'from and to must be YYYY-MM-DD dates');
  }
  if (from > to) {
    return apiResponse.badRequest(res, 'from must not be after to');
  }

  const figures = await getFinancialFigures(companyId, from, to);
  const data = toFinancialData(figures);
  const ratios = calculateFinancialRatios(data);

  return apiResponse.success(res, {
    period: { from, to },
    ratios,
    financialData: data,
    unclassifiedAccounts: unclassifiedWarning(figures.cumulative),
    inventory: inventoryWarning(figures),
  });
}

export default withAuth(withErrorHandler(handler));
