/**
 * A budget slice's review move (budgets P5 spec §3f, §4; P5-6), through sliceReviewState only.
 * POST /api/accounting/budgets/slices/<id>/submit   — a holder of the slice: open|returned → submitted
 * POST /api/accounting/budgets/slices/<id>/approve  { note? } — owner or admin: submitted → approved
 * POST /api/accounting/budgets/slices/<id>/return   { note }  — owner or admin: submitted → returned
 * → the slice. 400 a missing/long note, 403 the wrong person, 404 another company's slice, 409 the
 * slice is no longer in the status the move starts from (a racing move won) or the version is not a
 * draft. Each move is audited (entity 'budget') and notifies (submit: owners/admins; approve/return:
 * the holders). Write roles only; CSRF; 60 moves a minute per user (429 with Retry-After).
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { checkRateLimit } from '@/lib/rateLimit';
import { isUuidParam } from '@/lib/validation';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { MAX_SLICE_NOTE, SLICE_ACTIONS, transitionSlice, type SliceAction } from '@/modules/accounting/services/budgets/sliceReviewState';

const BodySchema = z.object({ note: z.string().max(MAX_SLICE_NOTE * 2).optional() }).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { id, action } = req.query;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a budget slice id');
  if (typeof action !== 'string' || !(SLICE_ACTIONS as readonly string[]).includes(action)) {
    return apiResponse.notFound(res, 'Budget slice action', String(action));
  }
  if (!(await checkRateLimit(`budget-slice:${userId}`, { max: 60, windowSecs: 60 }))) {
    res.setHeader('Retry-After', '60');
    return apiResponse.tooManyRequests(res, 'Too many budget slice changes; wait a minute and try again.');
  }
  const parsed = BodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  try {
    const slice = await transitionSlice(companyId, id, action as SliceAction, { userId, role: companyRole }, parsed.data.note);
    return apiResponse.success(res, slice);
  } catch (err) {
    if (respondBudgetVersionError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
