// pages/api/accounting/afs/[documentId]/sections/[sectionId]/sign-off.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  signOffSection,
  ReviewError,
} from '@/modules/accounting/services/afs/afsReviewService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyReq = req as CompanyApiRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const documentId = req.query.documentId as string;
  const sectionId = req.query.sectionId as string;

  log.info('Section sign-off requested', { companyId, documentId, sectionId, userId }, 'afs-section-signoff-api');

  try {
    const result = await signOffSection(companyId, documentId, sectionId, userId);
    return apiResponse.success(res, result, 'Section signed off');
  } catch (err) {
    if (err instanceof ReviewError) {
      if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'AFS section', sectionId);
      return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
    }
    throw err;
  }
}

export default withCompany(withErrorHandler(handler as never));
