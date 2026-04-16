// pages/api/accounting/portal/documents.ts — GET
// Auth: withPortalAuth — returns AFS docs filtered by portal access rules.

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
  const rules = PORTAL_ACCESS_RULES[role];
  const { documentTypes, statuses } = rules;

  log.info('Portal: listing documents', { companyId, role }, 'portal-documents-api');

  const documents = await sql`
    SELECT id, fiscal_year, period, document_type, status, created_at, updated_at
    FROM afs_documents
    WHERE company_id = ${companyId}::UUID
      AND document_type = ANY(${documentTypes}::TEXT[])
      AND (${statuses.length === 0} OR status = ANY(${statuses}::TEXT[]))
    ORDER BY created_at DESC
  `;

  return apiResponse.success(res, { documents });
}

export default withPortalAuth(withErrorHandler(handler as never) as never);
