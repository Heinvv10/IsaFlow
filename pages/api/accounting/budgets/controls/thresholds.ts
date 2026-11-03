/**
 * Alert threshold overrides (budgets P5 spec §4, decision 9: per account or per slice).
 * POST { glAccountId, cc1Id?, cc2Id?, buId?, thresholds } → the override (created, or replaced for
 *   the same account and slice). An expense account of this company; at most one dimension, this
 *   company's, CC1/CC2 of its kind (400 otherwise). Thresholds: 1-5 whole percentages 1-999.
 * DELETE { id } → { deleted: true } (404 when not this company's).
 * Owner or admin, CSRF. Each change writes one audit row.
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { respondBudgetControlsError } from '@/lib/budgetControlsResponse';
import { deleteThresholdOverride, upsertThresholdOverride } from '@/modules/accounting/services/budgets/budgetControlSettings';
import { ThresholdsSchema } from '@/modules/accounting/services/budgets/budgetControlSchemas';

const UpsertSchema = z.object({
  glAccountId: UUID,
  cc1Id: UUID.nullable().default(null),
  cc2Id: UUID.nullable().default(null),
  buId: UUID.nullable().default(null),
  thresholds: ThresholdsSchema,
}).strict();
const DeleteSchema = z.object({ id: UUID }).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  try {
    if (req.method === 'POST') {
      const parsed = UpsertSchema.safeParse(req.body);
      if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
      return apiResponse.success(res, { override: await upsertThresholdOverride(companyId, userId, parsed.data) });
    }
    if (req.method === 'DELETE') {
      const parsed = DeleteSchema.safeParse(req.body);
      if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
      await deleteThresholdOverride(companyId, userId, parsed.data.id);
      return apiResponse.success(res, { deleted: true as const });
    }
    return apiResponse.methodNotAllowed(res, req.method!, ['POST', 'DELETE']);
  } catch (err) {
    if (respondBudgetControlsError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler, { allowedRoles: ['owner', 'admin'] }))));
