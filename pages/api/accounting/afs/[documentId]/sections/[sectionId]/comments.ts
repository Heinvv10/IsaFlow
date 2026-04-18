// pages/api/accounting/afs/[documentId]/sections/[sectionId]/comments.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  listComments,
  addComment,
  CommentError,
} from '@/modules/accounting/services/afs/afsSectionCommentService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyReq = req as CompanyAuthedRequest;
  const { companyId } = companyReq;
  const sectionId = req.query.sectionId as string;

  if (req.method === 'GET') {
    const items = await listComments(companyId, sectionId);
    return apiResponse.success(res, { items });
  }

  if (req.method === 'POST') {
    const userId = companyReq.user.id;
    const { body, parentId } = req.body ?? {};

    if (!body || typeof body !== 'string' || body.trim().length === 0) {
      return apiResponse.badRequest(res, 'Comment body is required');
    }

    log.info('Adding comment', { companyId, sectionId, userId, parentId }, 'afs-comments-api');

    try {
      const comment = await addComment(companyId, sectionId, userId, body.trim(), parentId);
      return apiResponse.created(res, comment, 'Comment added');
    } catch (err) {
      if (err instanceof CommentError && err.code === 'NOT_FOUND') {
        return apiResponse.notFound(res, 'AFS section or parent comment', sectionId);
      }
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(handler as never));
