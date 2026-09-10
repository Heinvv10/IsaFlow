// pages/api/accounting/afs/[documentId]/sections/[sectionId]/sign-off.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { signOffSection } from '@/modules/accounting/services/afs/afsReviewService';
import { sendReviewError } from '@/modules/accounting/services/afs/afsReviewErrorResponse';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyReq = req as CompanyAuthedRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const documentId = req.query.documentId as string;
  const sectionId = req.query.sectionId as string;

  log.info('Section sign-off requested', { companyId, documentId, sectionId, userId }, 'afs-section-signoff-api');

  try {
    const result = await signOffSection(companyId, documentId, sectionId, userId);
    return apiResponse.success(res, result, 'Section signed off');
  } catch (err) {
    if (sendReviewError(res, err, 'AFS section', sectionId)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
