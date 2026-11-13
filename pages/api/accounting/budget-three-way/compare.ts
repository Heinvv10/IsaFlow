/**
 * Compare up to three budget versions' three-way runs (Budgets P6, spec §7, §13.22).
 * GET ?version_ids=a,b,c (1-3, one company, one fiscal year) → { fiscalYear, months, versions: [{ versionId, name,
 *   cashSeries, cashDelta, minCashMonth, kpis: { closingCash, minCash, netProfit, closingReceivables,
 *   closingPayables, netDebt } each { value, delta, deltaPct, favourable } }] }. Δ = version − first; cents.
 * 403 without the `budgets_three_way` flag, 404 any version not the company's (no data), 422 a bad query,
 * 400 BUDGET_THREE_WAY_INPUT versions of different years. Read-only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { localISODate } from '@/lib/dateUtils';
import { passThreeWayGate } from '@/lib/budgetThreeWayGate';
import { respondThreeWayError } from '@/lib/budgetThreeWayResponse';
import { CompareQuerySchema } from '@/modules/accounting/services/budgets/threeWay/routeSchemas';
import { compareView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  if (!(await passThreeWayGate(res, companyId, userId, 'read'))) return;
  const q = CompareQuerySchema.safeParse(req.query);
  if (!q.success) return apiResponse.zodValidationError(res, q.error);
  try {
    return apiResponse.success(res, await compareView(companyId, q.data.version_ids, localISODate()));
  } catch (err) {
    if (respondThreeWayError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(handler));
