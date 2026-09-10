// pages/api/accounting/afs/[documentId]/sign-off.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { signOffDocument } from '@/modules/accounting/services/afs/afsReviewService';
import { sendReviewError } from '@/modules/accounting/services/afs/afsReviewErrorResponse';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyReq = req as CompanyAuthedRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const documentId = req.query.documentId as string;

  log.info('Document sign-off requested', { companyId, documentId, userId }, 'afs-sign-off-api');

  try {
    const result = await signOffDocument(companyId, documentId, userId);
    return apiResponse.success(res, result, 'Document signed off successfully');
  } catch (err) {
    if (sendReviewError(res, err, 'AFS document', documentId)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
