/**
 * Planned hires (Budgets P4 decision 7): roles the user plans, per version (never a person's name)
 * GET    ?versionId=<uuid>                                                  → { hires }
 * POST   { versionId, expectedUpdatedAt, label, costCentreId?, startMonth, endMonth?, fte? }     → { hire, updatedAt, recomputed, warnings }
 * PUT    { versionId, expectedUpdatedAt, id, label, costCentreId?, startMonth, endMonth?, fte? } → { hire, updatedAt, recomputed, warnings }
 * DELETE ?versionId=<uuid>&expectedUpdatedAt=<token>&id=<hire id>                               → { deleted, id, updatedAt, recomputed, warnings }
 * Months 'YYYY-MM' overlapping the version's year; FTE > 0 (default 1, 2 dp). Every write compares-and-sets
 * the version's token first (409 BUDGET_VERSION_LOCKED / STALE with `currentUpdatedAt`), recomputes its per_head drivers and writes one audit
 * row; 400 for a bad hire or another company's cost centre, 404 for another company's version or
 * hire. Writes are charged to `budget-driver:<userId>` (120 a minute; 429 with Retry-After past it).
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { isUuidParam } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';
import { respondBudgetDriverError } from '@/lib/budgetDriverResponse';
import { createHire, deleteHire, listHires, updateHire } from '@/modules/accounting/services/budgets/drivers/plannedHireService';
import { isVersionToken } from '@/modules/accounting/services/budgets/gridErrors';

const Token = z.string().max(40).refine(isVersionToken, 'expectedUpdatedAt must be the updatedAt the version was read with');
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Months are YYYY-MM');
const HireSchema = z.object({
  versionId: UUID,
  // A real timestamp, checked here: one Postgres cannot read (30 February, offset +99) would be a 500 at the compare.
  expectedUpdatedAt: Token,
  // The 1-120 character limit applies after trimming (the service); this only bounds the body.
  label: z.string().max(500),
  costCentreId: UUID.nullable().default(null),
  startMonth: Month,
  endMonth: Month.nullable().default(null),
  fte: z.number().default(1),
});
const UpdateSchema = HireSchema.extend({ id: UUID });

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const method = req.method ?? 'GET';
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return apiResponse.methodNotAllowed(res, method, ['GET', 'POST', 'PUT', 'DELETE']);
  if (method !== 'GET' && !(await checkRateLimit(`budget-driver:${userId}`, { max: 120, windowSecs: 60 }))) {
    res.setHeader('Retry-After', '60');
    return apiResponse.tooManyRequests(res, 'Too many budget driver changes; wait a minute and try again.');
  }
  try {
    if (method === 'GET' || method === 'DELETE') {
      const { versionId, id, expectedUpdatedAt } = req.query;
      if (!isUuidParam(versionId)) return apiResponse.badRequest(res, 'versionId must be a version id');
      if (method === 'GET') return apiResponse.success(res, await listHires(companyId, versionId));
      if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a planned hire id');
      const token = Token.safeParse(expectedUpdatedAt);
      if (!token.success) return apiResponse.badRequest(res, 'expectedUpdatedAt must be the updatedAt the version was read with');
      return apiResponse.success(res, await deleteHire(companyId, userId, { versionId, expectedUpdatedAt: token.data }, id));
    }
    if (method === 'POST') {
      const parsed = HireSchema.safeParse(req.body);
      if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
      const { versionId, expectedUpdatedAt, ...hire } = parsed.data;
      return apiResponse.success(res, await createHire(companyId, userId, { versionId, expectedUpdatedAt }, hire));
    }
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
    const { versionId, expectedUpdatedAt, id, ...hire } = parsed.data;
    return apiResponse.success(res, await updateHire(companyId, userId, { versionId, expectedUpdatedAt }, id, hire));
  } catch (err) {
    if (respondBudgetDriverError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
