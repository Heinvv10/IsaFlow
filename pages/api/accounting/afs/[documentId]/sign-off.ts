// pages/api/accounting/afs/[documentId]/sign-off.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  signOffDocument,
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

  log.info('Document sign-off requested', { companyId, documentId, userId }, 'afs-sign-off-api');

  try {
    const result = await signOffDocument(companyId, documentId, userId);
    return apiResponse.success(res, result, 'Document signed off successfully');
  } catch (err) {
    if (err instanceof ReviewError) {
      if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'AFS document', documentId);
      return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
    }
    throw err;
  }
}

export default withCompany(withErrorHandler(handler as never));
