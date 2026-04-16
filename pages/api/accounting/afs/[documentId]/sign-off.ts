// pages/api/accounting/afs/[documentId]/sign-off.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getAfsDocument, lockAfsDocument } from '@/modules/accounting/services/afs/afsDocumentService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyReq = req as CompanyApiRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const documentId = req.query.documentId as string;

  log.info('Sign-off requested', { companyId, documentId, userId }, 'afs-sign-off-api');

  const existing = await getAfsDocument(documentId, companyId);
  if (!existing) {
    return apiResponse.notFound(res, 'AFS document', documentId);
  }

  if (existing.status === 'signed_off' || existing.status === 'filed') {
    return apiResponse.badRequest(res, `Document is already ${existing.status}`);
  }

  const document = await lockAfsDocument(documentId, companyId, userId);
  return apiResponse.success(res, { document }, 'Document signed off successfully');
}

export default withCompany(withErrorHandler(handler as never));
