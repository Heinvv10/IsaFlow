/**
 * POST — approves a draft under a named approver.
 *
 * This is the one place draft text becomes publishable. The approver is the
 * authenticated user; nothing in the request body can name someone else.
 *
 * Body is optional. No `text` key: draft_text is copied to approved_text. A
 * `text` key: that string (and only a string — it is never coerced) becomes
 * approved_text and draft_text stays the machine draft.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { isUuidParam } from '@/lib/validation';
import { withAuth, withCsrf, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { approveCommentary } from '@/modules/accounting/services/commentary/commentaryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const id = req.query.id;
  if (!isUuidParam(id)) return apiResponse.notFound(res, 'Commentary');

  const body: unknown = req.body;
  const supplied = typeof body === 'object' && body !== null && 'text' in body;
  const text: unknown = supplied ? (body as { text: unknown }).text : undefined;
  if (supplied && typeof text !== 'string') return apiResponse.badRequest(res, 'text must be a string.');

  const result = typeof text === 'string'
    ? await approveCommentary(companyId, id, user.id, text)
    : await approveCommentary(companyId, id, user.id);
  if (!result.ok) {
    // A row belonging to another company answers the same 404 as one that does
    // not exist: no probe distinguishes them.
    if (result.code === 'not_found') return apiResponse.notFound(res, 'Commentary');
    if (result.code === 'empty_draft' || result.code === 'commentary_budget_exceeded') return apiResponse.badRequest(res, result.reason);
    return apiResponse.conflict(res, result.reason);
  }
  return apiResponse.success(res, { commentary: result.row });
}

// Approving publishes a sentence to anyone holding the share link. That is an
// owner/admin decision, the same gate the link itself carries.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler, { allowedRoles: ['owner', 'admin'] }))));
