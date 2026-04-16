// pages/api/accounting/portal/documents/[documentId].ts — GET
// Auth: withPortalAuth — single document + sections, access-rule enforced.

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { withPortalAuth, type PortalApiRequest } from '@/lib/auth/portalAuth';
import { PORTAL_ACCESS_RULES } from '@/modules/accounting/services/afs/afsTypes';

async function handler(req: PortalApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId, role } = req.portalSession;
  const documentId = req.query.documentId as string;
  if (!documentId) return apiResponse.badRequest(res, 'documentId is required');

  log.info('Portal: loading document', { companyId, documentId, role }, 'portal-document-api');

  const docs = (await sql`
    SELECT id, fiscal_year, period, document_type, status, signing_requested_at, created_at, updated_at
    FROM afs_documents
    WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Array<{ id: string; document_type: string; status: string }>;

  if (docs.length === 0) return apiResponse.notFound(res, 'Document', documentId);

  const doc = docs[0]!;

  // Enforce portal access rules
  const rules = PORTAL_ACCESS_RULES[role];
  if (!rules.documentTypes.includes(doc.document_type as 'afs' | 'management_pack')) {
    return apiResponse.forbidden(res, 'You do not have access to this document type');
  }
  if (rules.statuses.length > 0 && !rules.statuses.includes(doc.status)) {
    return apiResponse.forbidden(
      res,
      'You do not have access to this document in its current status',
    );
  }

  // Load sections (exclude version_history for payload size)
  const sections = await sql`
    SELECT id, section_type, sort_order, status, content, ai_narrative, created_at, updated_at
    FROM afs_sections
    WHERE document_id = ${documentId}::UUID AND company_id = ${companyId}::UUID
    ORDER BY sort_order ASC
  `;

  return apiResponse.success(res, { document: doc, sections });
}

export default withPortalAuth(withErrorHandler(handler as never) as never);
