/**
 * Entity change history (forensic-controls step 3, migration 888)
 * GET — newest first, paged by `before` (the previous page's nextCursor, a change id),
 *       `limit` up to 100:
 *   - `?entityType=&entityId=` one entity's timeline: whoever may read that
 *     type (suppliers / customers / GL accounts: any member; employees: owner,
 *     admin, manager; the rest: owner, admin) — else 403;
 *   - no `entityId`: the company-wide feed (optionally one `entityType`),
 *     owner / admin only.
 * `?entityType=payroll_bank_detail&employeeId=` an employee's bank-detail changes across every row they have had
 *   (a change retires a row and inserts a new id); same roles and masking.
 * A `before` that is not a change of this same history is 400 (never an empty page).
 * Bank account and ID / tax numbers come back masked (…1234); employee bank
 * details also mask the branch code (…55) and holder (K…); owner / admin
 * reveal one change through POST /api/accounting/entity-changes-reveal.
 * On THIS route payroll_bank_detail history is for a person in their own session only: the bank-detail paths (entityId,
 * employeeId, entityType) refuse Login-as (403 IMPERSONATION_FORBIDDEN) and tokens (403 AGENT_FORBIDDEN), as the
 * bank-details route does, and the all-types feed leaves those rows out for any such session.
 * MCP is the deliberate exception (Hein, 2026-11-04): `entity_history` and `compare_audit_snapshot` return the MASKED
 * bank-detail history (…last4, branch …last2, holder initial, never a reveal) to a token holder with an owner / admin /
 * manager role and read:payroll.
 * RLS (entity_changes_read) enforces the same reading rules underneath.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { assertHumanSession, isHumanSession } from '@/modules/accounting/services/bank/bankControlRefusal';
import { respondIfBankControlRefused } from '@/modules/accounting/services/bank/bankControlResponse';
import {
  EntityChangeCursorError, listEntityChanges, MAX_PAGE, type ListEntityChangesOptions,
} from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import {
  ENTITY_TYPES, isHistoryAdmin, mayReadType,
} from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';

const Query = z.object({
  entityType: z.enum(ENTITY_TYPES).optional(),
  entityId: UUID.optional(),
  employeeId: UUID.optional(),
  before: UUID.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(50),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const parsed = Query.safeParse(req.query);
  if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  const { entityType, entityId, employeeId, before, limit } = parsed.data;

  // Employee bank-detail history is read only by a person in their own session, as the bank-details route itself:
  // Login-as and tokens are refused. Other entity types are unchanged.
  if (entityType === 'payroll_bank_detail') {
    try {
      await assertHumanSession('read employee bank details');
    } catch (err) {
      if (respondIfBankControlRefused(res, err)) return;
      throw err;
    }
  }

  if (employeeId) {
    // An employee's bank-detail history across all their rows: same role rule and masking as one entity's.
    if (entityId || entityType !== 'payroll_bank_detail') {
      return apiResponse.badRequest(res, 'employeeId goes with entityType=payroll_bank_detail alone');
    }
    if (!mayReadType(companyRole, entityType)) {
      return apiResponse.forbidden(res, `Your role (${companyRole ?? 'unknown'}) cannot view this history.`);
    }
    return page(res, companyId, { types: [entityType], entityType, employeeId, before, limit });
  }

  if (entityId) {
    if (!entityType) return apiResponse.badRequest(res, 'entityType is required with entityId');
    if (!mayReadType(companyRole, entityType)) {
      return apiResponse.forbidden(res, `Your role (${companyRole ?? 'unknown'}) cannot view this history.`);
    }
    return page(res, companyId, { types: [entityType], entityType, entityId, before, limit });
  }
  if (!isHistoryAdmin(companyRole)) {
    return apiResponse.forbidden(res, 'Only an owner or admin can view the company-wide change history.');
  }
  // The all-types feed carries bank-detail rows too: a Login-as or token session gets the feed without them.
  const human = entityType ? true : await isHumanSession();
  const types = entityType ? [entityType] : ENTITY_TYPES.filter((t) => human || t !== 'payroll_bank_detail');
  return page(res, companyId, { types, entityType, before, limit });
}

async function page(res: NextApiResponse, companyId: string, opts: ListEntityChangesOptions) {
  try {
    return apiResponse.success(res, await listEntityChanges(companyId, opts));
  } catch (err) {
    if (err instanceof EntityChangeCursorError) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(handler)));
