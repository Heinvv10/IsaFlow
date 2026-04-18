// pages/api/accounting/afs/[documentId]/index.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getAfsDocument } from '@/modules/accounting/services/afs/afsDocumentService';
import { getAfsSectionsForDocument } from '@/modules/accounting/services/afs/afsSectionService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const documentId = req.query.documentId as string;

  log.info('Fetching AFS document with sections', { companyId, documentId }, 'afs-document-api');

  const document = await getAfsDocument(documentId, companyId);
  if (!document) {
    return apiResponse.notFound(res, 'AFS document', documentId);
  }

  const sections = await getAfsSectionsForDocument(documentId, companyId);
  return apiResponse.success(res, { document: { ...document, sections } });
}

export default withAuth(withErrorHandler(handler as never));
