// pages/api/accounting/afs/[documentId]/sections/[sectionId]/review.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  markSectionReviewed,
  ReviewError,
} from '@/modules/accounting/services/afs/afsReviewService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyReq = req as CompanyAuthedRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const documentId = req.query.documentId as string;
  const sectionId = req.query.sectionId as string;

  log.info('Section review requested', { companyId, documentId, sectionId, userId }, 'afs-section-review-api');

  try {
    const result = await markSectionReviewed(companyId, documentId, sectionId, userId);
    return apiResponse.success(res, result, 'Section marked as reviewed');
  } catch (err) {
    if (err instanceof ReviewError) {
      if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'AFS section', sectionId);
      return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(handler as never));
