/**
 * POST — discards a draft. Nothing is published and no approval column is
 * touched; a rejected sentence simply stops being offered for approval.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCsrf, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { rejectCommentary } from '@/modules/accounting/services/commentary/commentaryService';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const id = req.query.id;
  if (typeof id !== 'string' || !UUID.test(id)) return apiResponse.notFound(res, 'Commentary');

  const result = await rejectCommentary(companyId, id, user.id);
  if (!result.ok) {
    if (result.code === 'not_found') return apiResponse.notFound(res, 'Commentary');
    if (result.code === 'empty_draft') return apiResponse.badRequest(res, result.reason);
    return apiResponse.conflict(res, result.reason);
  }
  return apiResponse.success(res, { commentary: result.row });
}

// Discarding a draft publishes nothing, so it sits at the ordinary write gate:
// a manager who may generate drafts may also throw one away. Approving does not.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
