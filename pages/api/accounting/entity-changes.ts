/**
 * Entity change history (forensic-controls step 3, migration 888)
 * GET — newest first, paged by `before` (the previous page's nextCursor, a change id),
 *       `limit` up to 100:
 *   - `?entityType=&entityId=` one entity's timeline: whoever may read that
 *     type (suppliers / customers / GL accounts: any member; employees: owner,
 *     admin, manager; the rest: owner, admin) — else 403;
 *   - no `entityId`: the company-wide feed (optionally one `entityType`),
 *     owner / admin only.
 * Bank account and ID / tax numbers come back masked (…1234); owner / admin
 * reveal one change through POST /api/accounting/entity-changes-reveal.
 * RLS (entity_changes_read) enforces the same reading rules underneath.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { listEntityChanges, MAX_PAGE } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import {
  ENTITY_TYPES, isHistoryAdmin, mayReadType,
} from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';

const Query = z.object({
  entityType: z.enum(ENTITY_TYPES).optional(),
  entityId: UUID.optional(),
  before: UUID.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(50),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const parsed = Query.safeParse(req.query);
  if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  const { entityType, entityId, before, limit } = parsed.data;

  if (entityId) {
    if (!entityType) return apiResponse.badRequest(res, 'entityType is required with entityId');
    if (!mayReadType(companyRole, entityType)) {
      return apiResponse.forbidden(res, `Your role (${companyRole ?? 'unknown'}) cannot view this history.`);
    }
    return apiResponse.success(res, await listEntityChanges(companyId, { types: [entityType], entityType, entityId, before, limit }));
  }
  if (!isHistoryAdmin(companyRole)) {
    return apiResponse.forbidden(res, 'Only an owner or admin can view the company-wide change history.');
  }
  const types = entityType ? [entityType] : ENTITY_TYPES;
  return apiResponse.success(res, await listEntityChanges(companyId, { types, entityType, before, limit }));
}

export default withAuth(withErrorHandler(withCsrf(handler)));
