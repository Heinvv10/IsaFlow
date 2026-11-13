/**
 * Three-way budget (Budgets P6, spec §7, §13): one version's budgeted balance sheet and cash flow.
 * GET ?version_id= (default: the primary of ?fiscal_year=, else of the year holding today)
 *   → { version, months, opening, pnl, balanceSheet, cashFlow: { direct, indirect }, runway, checks, warnings,
 *       vatSettlements, taxEvents, assumptions: { resolved, chain, stored } }. Money in integer cents.
 * 403 when the company lacks the `budgets_three_way` flag, 404 another company's version (no data), 422 a bad
 * query, 400 a scenario chain that cannot resolve, 409 an opening balance sheet that does not balance. Read-only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { localISODate } from '@/lib/dateUtils';
import { passThreeWayGate } from '@/lib/budgetThreeWayGate';
import { respondThreeWayError } from '@/lib/budgetThreeWayResponse';
import { ThreeWayQuerySchema } from '@/modules/accounting/services/budgets/threeWay/routeSchemas';
import { getThreeWay } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  if (!(await passThreeWayGate(res, companyId, userId, 'read'))) return;
  const parsed = ThreeWayQuerySchema.safeParse(req.query);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  try {
    const { version_id: versionId, fiscal_year: fiscalYear } = parsed.data;
    return apiResponse.success(res, await getThreeWay(companyId, { versionId, fiscalYear }, localISODate()));
  } catch (err) {
    if (respondThreeWayError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(handler));
