// pages/api/accounting/afs/[documentId]/sections/[sectionId]/comments.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID, requireUuidParam } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sendReviewError } from '@/modules/accounting/services/afs/afsReviewErrorResponse';
import {
  listComments,
  addComment,
  CommentError,
} from '@/modules/accounting/services/afs/afsSectionCommentService';

const AddCommentSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
  parentId: UUID.optional(),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyReq = req as CompanyAuthedRequest;
  const { companyId } = companyReq;
  const documentId = requireUuidParam(req, res, 'documentId');
  if (!documentId) return;
  const sectionId = requireUuidParam(req, res, 'sectionId');
  if (!sectionId) return;

  if (req.method === 'GET') {
    try {
      const items = await listComments(companyId, documentId, sectionId);
      return apiResponse.success(res, { items });
    } catch (err) {
      if (err instanceof CommentError && err.code === 'NOT_FOUND') {
        return apiResponse.notFound(res, 'AFS section', sectionId);
      }
      throw err;
    }
  }

  if (req.method === 'POST') {
    const userId = companyReq.user.id;
    const parsed = AddCommentSchema.safeParse(req.body);
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
    const { body, parentId } = parsed.data;

    log.info('Adding comment', { companyId, documentId, sectionId, userId, parentId }, 'afs-comments-api');

    try {
      const comment = await addComment(companyId, documentId, sectionId, userId, body, parentId);
      return apiResponse.created(res, comment, 'Comment added');
    } catch (err) {
      // addComment goes through the section write guard: a section of another document is 404,
      // a locked or out-for-signature document 409.
      if (sendReviewError(res, err, 'AFS section', sectionId)) return;
      if (err instanceof CommentError && err.code === 'NOT_FOUND') {
        return apiResponse.notFound(res, 'AFS section or parent comment', sectionId);
      }
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
