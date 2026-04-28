// pages/api/accounting/afs/[documentId]/sections/[sectionId]/comments.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
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
  const sectParse = UUID.safeParse(req.query.sectionId);
  if (!sectParse.success) return apiResponse.badRequest(res, 'sectionId must be a valid UUID');
  const sectionId = sectParse.data;

  if (req.method === 'GET') {
    const items = await listComments(companyId, sectionId);
    return apiResponse.success(res, { items });
  }

  if (req.method === 'POST') {
    const userId = companyReq.user.id;
    const parsed = AddCommentSchema.safeParse(req.body);
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
    const { body, parentId } = parsed.data;

    log.info('Adding comment', { companyId, sectionId, userId, parentId }, 'afs-comments-api');

    try {
      const comment = await addComment(companyId, sectionId, userId, body, parentId);
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

export default withAuth(withErrorHandler(withCsrf(handler as never)));
