// pages/api/accounting/afs/[documentId]/sections/[sectionId]/comments/[commentId]/resolve.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  resolveComment,
  CommentError,
} from '@/modules/accounting/services/afs/afsSectionCommentService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyReq = req as CompanyAuthedRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const commentId = req.query.commentId as string;

  log.info('Resolving comment', { companyId, commentId, userId }, 'afs-comment-resolve-api');

  try {
    const comment = await resolveComment(companyId, commentId, userId);
    return apiResponse.success(res, comment, 'Comment resolved');
  } catch (err) {
    if (err instanceof CommentError) {
      if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'Comment', commentId);
      return apiResponse.error(res, ErrorCode.FORBIDDEN, err.message);
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(handler as never));
