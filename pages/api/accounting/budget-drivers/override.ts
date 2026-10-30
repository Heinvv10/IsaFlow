/**
 * Reset to driver (Budgets P4 spec §1.2)
 * POST { versionId, expectedUpdatedAt, glAccountId, cc1Id, cc2Id, buId, month? } → { reset, updatedAt, recomputed, warnings }
 * The row's 'override' cell for `month` (or every override cell of the row when `month` is absent
 * or null) goes back to its driver's value: the version's token is compared-and-set first (409
 * BUDGET_VERSION_LOCKED / BUDGET_VERSION_STALE), the drivers recompute, one audit row. 400 when the row has no driver or
 * the month is outside its range; 404 for another company's version. Charged to the user's
 * `budget-driver:<userId>` bucket (120 a minute; 429 with Retry-After past it).
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { checkRateLimit } from '@/lib/rateLimit';
import { respondBudgetDriverError } from '@/lib/budgetDriverResponse';
import { resetOverride } from '@/modules/accounting/services/budgets/drivers/driverWriteService';
import { isVersionToken } from '@/modules/accounting/services/budgets/gridErrors';

const Token = z.string().max(40).refine(isVersionToken, 'expectedUpdatedAt must be the updatedAt the version was read with');

const ResetSchema = z.object({
  versionId: UUID,
  // A real timestamp, checked here: one Postgres cannot read (30 February, offset +99) would be a 500 at the compare.
  expectedUpdatedAt: Token,
  glAccountId: UUID,
  cc1Id: UUID.nullable().default(null),
  cc2Id: UUID.nullable().default(null),
  buId: UUID.nullable().default(null),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month is YYYY-MM').nullable().default(null),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  if (!(await checkRateLimit(`budget-driver:${userId}`, { max: 120, windowSecs: 60 }))) {
    res.setHeader('Retry-After', '60');
    return apiResponse.tooManyRequests(res, 'Too many budget driver changes; wait a minute and try again.');
  }
  const parsed = ResetSchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  const { versionId, expectedUpdatedAt, ...row } = parsed.data;
  try {
    return apiResponse.success(res, await resetOverride(companyId, userId, { versionId, expectedUpdatedAt }, row));
  } catch (err) {
    if (respondBudgetDriverError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
