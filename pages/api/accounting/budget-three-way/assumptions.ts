/**
 * Three-way assumptions of one budget version (Budgets P6, spec §4, §7, §13 items 18-21).
 * GET ?version_id= → { version, stored: { doc, updatedAt, updatedBy } | null, resolved, chain, derived }
 * PUT { version_id, doc, expected_updated_at } → { versionId, doc, updatedAt, updatedBy }
 *   `doc` is a full document, or (a scenario only) `{ schemaVersion: 1, overrides }` whose chain must resolve.
 *   `expected_updated_at` is the stored row's `updatedAt` as read, null when none was stored.
 * 403 without the `budgets_three_way` flag (or for a role without write access, PUT), 404 another company's
 * version, 422 a bad body or query, 400 BUDGET_ASSUMPTIONS_INVALID (issues by path) / BUDGET_SCENARIO_CHAIN,
 * 409 BUDGET_VERSION_LOCKED, 409 BUDGET_ASSUMPTIONS_STALE `{ code, currentUpdatedAt }`. Every refusal writes
 * nothing; a save writes the row and one audit row (entity 'budget', the version, before/after per section).
 * Writes: CSRF, write roles, `budget-three-way-save:<user>` 120 a minute (the grid save's rules).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { localISODate } from '@/lib/dateUtils';
import { passThreeWayGate } from '@/lib/budgetThreeWayGate';
import { respondThreeWayError } from '@/lib/budgetThreeWayResponse';
import { saveAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsRepo';
import { AssumptionsPutSchema, VersionQuerySchema } from '@/modules/accounting/services/budgets/threeWay/routeSchemas';
import { getAssumptionsView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'PUT') return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'PUT']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  if (!(await passThreeWayGate(res, companyId, userId, req.method === 'PUT' ? 'save' : 'read'))) return;
  try {
    if (req.method === 'GET') {
      const q = VersionQuerySchema.safeParse(req.query);
      if (!q.success) return apiResponse.zodValidationError(res, q.error);
      return apiResponse.success(res, await getAssumptionsView(companyId, q.data.version_id, localISODate()));
    }
    const body = AssumptionsPutSchema.safeParse(req.body);
    if (!body.success) return apiResponse.zodValidationError(res, body.error);
    const saved = await saveAssumptions(companyId, userId, {
      versionId: body.data.version_id, doc: body.data.doc, expectedUpdatedAt: body.data.expected_updated_at,
    });
    return apiResponse.success(res, { versionId: body.data.version_id.toLowerCase(), ...saved });
  } catch (err) {
    if (respondThreeWayError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
