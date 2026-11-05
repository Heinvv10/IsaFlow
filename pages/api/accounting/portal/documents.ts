// pages/api/accounting/portal/documents.ts — GET
// Auth: withPortalAuth — returns AFS docs filtered by portal access rules.

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { withPortalAuth, type PortalApiRequest } from '@/lib/auth/portalAuth';
import { listPortalDocuments } from '@/modules/accounting/services/afs/portalDocumentService';

async function handler(req: PortalApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId, role } = req.portalSession;
  log.info('Portal: listing documents', { companyId, role }, 'portal-documents-api');

  const documents = await listPortalDocuments(companyId, role);
  return apiResponse.success(res, { documents });
}

export default withPortalAuth(withErrorHandler(handler as never) as never);
