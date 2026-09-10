// pages/api/accounting/afs/[documentId]/sections/[sectionId]/comments/[commentId]/resolve.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { requireUuidParam } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sendReviewError } from '@/modules/accounting/services/afs/afsReviewErrorResponse';
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
  const documentId = requireUuidParam(req, res, 'documentId');
  if (!documentId) return;
  const sectionId = requireUuidParam(req, res, 'sectionId');
  if (!sectionId) return;
  const commentId = requireUuidParam(req, res, 'commentId');
  if (!commentId) return;

  log.info('Resolving comment', { companyId, documentId, sectionId, commentId, userId }, 'afs-comment-resolve-api');

  try {
    const comment = await resolveComment(companyId, documentId, sectionId, commentId, userId);
    return apiResponse.success(res, comment, 'Comment resolved');
  } catch (err) {
    if (sendReviewError(res, err, 'AFS section', sectionId)) return;
    if (err instanceof CommentError) {
      if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'Comment', commentId);
      return apiResponse.error(res, ErrorCode.FORBIDDEN, err.message);
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
