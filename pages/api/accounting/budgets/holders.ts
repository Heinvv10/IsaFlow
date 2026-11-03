/**
 * Budget holders and their slices (budgets P5 spec §3f, §4; P5-6).
 * GET  ?versionId=<uuid>   → { slices: SliceReview[] }: an owner's or admin's every slice (of that
 *      version, or of every version), anyone else's own slices only ("My budget slices"; a viewer
 *      holds none: holders are manager+, decision 9a). withWriteAccess gates the POST.
 * POST { versionId, userId, cc1Id?, cc2Id?, buId?, glAccountIds?, dueDate? } → the slice (owner or
 *      admin only): the member (a manager, admin or owner) holds that slice of a DRAFT version;
 *      creates the slice's review row ('open') or updates its due date. 400 a bad slice, account or
 *      member (a viewer, a non-member), 403 another role, 404 another company's version, 409 a
 *      version that is not a draft.
 * DELETE ?id=<holder id> → { removed, sliceDeleted } (owner or admin): unassigns on a draft; 409 while
 *      the slice is submitted or approved; the last holder of an open/returned slice takes its review.
 * Every id is checked against the session's company (RLS and the queries both). CSRF on POST.
 * 60 writes a minute per user (429 with Retry-After).
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { checkRateLimit } from '@/lib/rateLimit';
import { isUuidParam } from '@/lib/validation';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { assignHolder, MAX_HOLDER_ACCOUNTS, unassignHolder } from '@/modules/accounting/services/budgets/budgetHolders';
import { listSlices } from '@/modules/accounting/services/budgets/sliceReviewRead';

/** A real calendar date 'YYYY-MM-DD' (Postgres would 500 on 2026-02-31). */
const RealDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').refine((d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d && d >= '1900-01-01' && d <= '2200-12-31';
}, 'Must be a real date');

const AssignSchema = z.object({
  versionId: UUID,
  userId: z.string().trim().min(1).max(255),
  cc1Id: UUID.nullable().default(null),
  cc2Id: UUID.nullable().default(null),
  buId: UUID.nullable().default(null),
  glAccountIds: z.array(UUID).min(1).max(MAX_HOLDER_ACCOUNTS).nullable().default(null),
  dueDate: RealDate.nullable().default(null),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const actor = { userId, role: companyRole };
  try {
    if (req.method === 'GET') {
      const versionId = req.query.versionId;
      if (versionId !== undefined && !isUuidParam(versionId)) return apiResponse.badRequest(res, 'versionId must be a version id');
      return apiResponse.success(res, { slices: await listSlices(companyId, actor, { versionId: versionId as string | undefined }) });
    }
    if (req.method !== 'POST' && req.method !== 'DELETE') return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'DELETE']);
    if (companyRole !== 'owner' && companyRole !== 'admin') {
      return apiResponse.forbidden(res, 'Only an owner or admin can assign budget holders');
    }
    if (!(await checkRateLimit(`budget-holders:${userId}`, { max: 60, windowSecs: 60 }))) {
      res.setHeader('Retry-After', '60');
      return apiResponse.tooManyRequests(res, 'Too many budget holder changes; wait a minute and try again.');
    }
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a budget holder id');
      return apiResponse.success(res, await unassignHolder(companyId, actor, id));
    }
    const parsed = AssignSchema.safeParse(req.body);
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
    return apiResponse.success(res, await assignHolder(companyId, actor, parsed.data));
  } catch (err) {
    if (respondBudgetVersionError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
