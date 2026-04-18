// pages/api/accounting/afs/[documentId]/generate.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getAfsDocument } from '@/modules/accounting/services/afs/afsDocumentService';
import { enqueueGenerationJob } from '@/modules/accounting/services/afs/afsGenerationJobService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyReq = req as CompanyAuthedRequest;
  const { companyId } = companyReq;
  const requestedBy = companyReq.user.id;
  const documentId = req.query.documentId as string;

  log.info('Generation job requested', { companyId, documentId }, 'afs-generate-api');

  const document = await getAfsDocument(documentId, companyId);
  if (!document) {
    return apiResponse.notFound(res, 'AFS document', documentId);
  }

  if (document.status === 'signed_off' || document.status === 'filed') {
    return apiResponse.badRequest(res, `Cannot generate a ${document.status} document`);
  }

  const job = await enqueueGenerationJob(documentId, companyId, requestedBy);
  return apiResponse.created(res, { job }, 'Generation job enqueued');
}

export default withAuth(withErrorHandler(handler as never));
