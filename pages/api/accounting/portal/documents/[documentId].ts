// pages/api/accounting/portal/documents/[documentId].ts — GET
// Auth: withPortalAuth — single document + sections, access-rule enforced.

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { withPortalAuth, type PortalApiRequest } from '@/lib/auth/portalAuth';
import { loadPortalDocument } from '@/modules/accounting/services/afs/portalDocumentService';

async function handler(req: PortalApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId, role } = req.portalSession;
  const documentId = req.query.documentId as string;
  if (!documentId) return apiResponse.badRequest(res, 'documentId is required');

  log.info('Portal: loading document', { companyId, documentId, role }, 'portal-document-api');

  const outcome = await loadPortalDocument(companyId, role, documentId);
  if (outcome.kind === 'not_found') return apiResponse.notFound(res, 'Document', documentId);
  if (outcome.kind === 'forbidden') return apiResponse.forbidden(res, outcome.message);
  return apiResponse.success(res, { document: outcome.document, sections: outcome.sections });
}

export default withPortalAuth(withErrorHandler(handler as never) as never);
