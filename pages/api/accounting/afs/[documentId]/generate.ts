// pages/api/accounting/afs/[documentId]/generate.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { lockDocumentForTransition } from '@/modules/accounting/services/afs/afsDocumentTransitions';
import { sendReviewError } from '@/modules/accounting/services/afs/afsReviewErrorResponse';
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

  // Generation rewrites every section, so it is refused wherever a section write is: a locked
  // document, and a document whose signatories are signing the content as it stands.
  let document;
  try {
    document = await lockDocumentForTransition(companyId, documentId);
  } catch (err) {
    if (sendReviewError(res, err, 'AFS document', documentId)) return;
    throw err;
  }

  if (document.status === 'signed_off' || document.status === 'filed') {
    return apiResponse.badRequest(res, `Cannot generate a ${document.status} document`);
  }
  if (document.signingRequestedAt) {
    return apiResponse.conflict(res, 'Document is out for signature — no generation until signing completes');
  }

  const job = await enqueueGenerationJob(documentId, companyId, requestedBy);
  return apiResponse.created(res, { job }, 'Generation job enqueued');
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
