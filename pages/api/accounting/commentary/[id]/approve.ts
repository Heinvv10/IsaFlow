/**
 * POST — copies draft_text to approved_text under a named approver.
 *
 * This is the one place draft text becomes publishable. The approver is the
 * authenticated user; nothing in the request body can name someone else.
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

  const result = await approveCommentary(companyId, id, user.id);
  if (!result.ok) {
    // A row belonging to another company answers the same 404 as one that does
    // not exist: no probe distinguishes them.
    if (result.code === 'not_found') return apiResponse.notFound(res, 'Commentary');
    if (result.code === 'empty_draft') return apiResponse.badRequest(res, result.reason);
    return apiResponse.conflict(res, result.reason);
  }
  return apiResponse.success(res, { commentary: result.row });
}

// Approving publishes a sentence to anyone holding the share link. That is an
// owner/admin decision, the same gate the link itself carries.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler, { allowedRoles: ['owner', 'admin'] }))));
