/**
 * Reforecast from actuals and the rolling forecast (Budgets P4 spec §5, §6), on version [id]
 * GET                                       → status { rolling, rolledThroughMonth, latestClosedMonth, staleMonths, reopenedMonths,
 *                                             unplaced, lastRolledAt, lastError }
 * POST { name, rolling? }                   → 201 { version, rolling, closedMonths, cells, unplaced, warnings }: a new draft
 *                                             reforecast based on [id], closed months = actuals, open months = [id]'s cells
 * POST { action: 'roll', expectedUpdatedAt } → Roll now { status, changed, closedMonths, rolledThroughMonth, unplaced, warnings, updatedAt }
 * PUT  { rolling, expectedUpdatedAt }        → { rolling, changed, updatedAt }: auto-roll on (a non-primary reforecast; one per
 *                                             year) or off
 * Months 'YYYY-MM'; unplaced amounts in rand. Roll now and the toggle compare-and-set the version's token first
 * (409 BUDGET_VERSION_LOCKED, or BUDGET_VERSION_STALE with `currentUpdatedAt` and `status`); a second rolling
 * forecast in a year, or Roll now on a version that does not roll, is 409 BUDGET_VERSION_STATE; 404 for another
 * company's version. Writes are charged to the user's `budget-reforecast:<userId>` bucket (30 a minute; each
 * reads the year's actuals four times), the status to `budget-reforecast-status:<userId>` (120 a minute; it
 * recomputes the unplaced actuals); 429 with Retry-After past either. Any member may read.
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { isUuidParam } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';
import { respondBudgetDriverError } from '@/lib/budgetDriverResponse';
import { createReforecastFromActuals } from '@/modules/accounting/services/budgets/drivers/reforecastService';
import { rollVersion, setRolling } from '@/modules/accounting/services/budgets/drivers/rollingForecastService';
import { rollingStatus } from '@/modules/accounting/services/budgets/drivers/rollingStatus';
import { isVersionToken } from '@/modules/accounting/services/budgets/gridErrors';

const Token = z.string().max(40).refine(isVersionToken, 'expectedUpdatedAt must be the updatedAt the version was read with');
// The 1-120 character limit applies after trimming (createVersion); this only bounds the body.
const CreateSchema = z.object({ name: z.string().max(500), rolling: z.boolean().default(false) }).strict();
const RollSchema = z.object({ action: z.literal('roll'), expectedUpdatedAt: Token }).strict();
const ToggleSchema = z.object({ rolling: z.boolean(), expectedUpdatedAt: Token }).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const method = req.method ?? 'GET';
  if (!['GET', 'POST', 'PUT'].includes(method)) return apiResponse.methodNotAllowed(res, method, ['GET', 'POST', 'PUT']);
  const { id } = req.query;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a version id');
  // The status recomputes the unplaced actuals (four actuals reads): its own, larger bucket.
  if (method === 'GET' && !(await checkRateLimit(`budget-reforecast-status:${userId}`, { max: 120, windowSecs: 60 }))) {
    res.setHeader('Retry-After', '60');
    return apiResponse.tooManyRequests(res, 'Too many reforecast status reads; wait a minute and try again.');
  }
  if (method !== 'GET' && !(await checkRateLimit(`budget-reforecast:${userId}`, { max: 30, windowSecs: 60 }))) {
    res.setHeader('Retry-After', '60');
    return apiResponse.tooManyRequests(res, 'Too many reforecast changes; wait a minute and try again.');
  }
  try {
    if (method === 'GET') return apiResponse.success(res, await rollingStatus(companyId, id));
    if (method === 'PUT') {
      const parsed = ToggleSchema.safeParse(req.body);
      if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
      return apiResponse.success(res, await setRolling(companyId, userId, id, parsed.data.rolling, parsed.data.expectedUpdatedAt));
    }
    const body: unknown = req.body;
    if (body && typeof body === 'object' && 'action' in body) {
      const parsed = RollSchema.safeParse(body);
      if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
      return apiResponse.success(res, await rollVersion(companyId, userId, id, { expectedUpdatedAt: parsed.data.expectedUpdatedAt }));
    }
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
    return apiResponse.created(res, await createReforecastFromActuals(companyId, { userId, role: companyRole }, id, parsed.data));
  } catch (err) {
    if (respondBudgetDriverError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
