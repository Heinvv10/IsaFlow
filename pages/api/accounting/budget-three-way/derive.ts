/**
 * Derived default assumptions for a version's year (Budgets P6, spec §4 "Derived defaults", §7).
 * POST { version_id } → { version, assumptions, evidence: { asAt, window, trailing, vat, statutory, opening,
 *   insufficientHistory, aging } }. Computes, NEVER writes (a save is PUT …/assumptions). Money in cents.
 * 403 without the `budgets_three_way` flag or write access, 404 another company's version, 422 a bad body.
 * CSRF; `budget-three-way:<user>` 60 a minute.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { localISODate } from '@/lib/dateUtils';
import { passThreeWayGate } from '@/lib/budgetThreeWayGate';
import { respondThreeWayError } from '@/lib/budgetThreeWayResponse';
import { DeriveBodySchema } from '@/modules/accounting/services/budgets/threeWay/routeSchemas';
import { deriveView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  if (!(await passThreeWayGate(res, companyId, userId, 'read'))) return;
  const body = DeriveBodySchema.safeParse(req.body);
  if (!body.success) return apiResponse.zodValidationError(res, body.error);
  try {
    return apiResponse.success(res, await deriveView(companyId, body.data.version_id, localISODate()));
  } catch (err) {
    if (respondThreeWayError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
