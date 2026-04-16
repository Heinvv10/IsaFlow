// pages/api/accounting/portal/documents/[documentId]/annotate.ts — POST
// Auth: withPortalAuth — adds a comment with author_type = 'portal'.

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { withPortalAuth, type PortalApiRequest } from '@/lib/auth/portalAuth';
import { PORTAL_ACCESS_RULES } from '@/modules/accounting/services/afs/afsTypes';
import { notifyAnnotationReceived } from '@/modules/accounting/services/afs/portalNotificationService';

async function handler(req: PortalApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId, role, contactId } = req.portalSession;
  const documentId = req.query.documentId as string;
  if (!documentId) return apiResponse.badRequest(res, 'documentId is required');

  // Check annotation permission
  const rules = PORTAL_ACCESS_RULES[role];
  if (!rules.canAnnotate) {
    return apiResponse.forbidden(res, 'Your role does not allow annotations');
  }

  const { sectionId, body: commentBody } = req.body as {
    sectionId?: string;
    body?: string;
  };
  if (!sectionId || typeof sectionId !== 'string') {
    return apiResponse.badRequest(res, 'sectionId is required');
  }
  if (!commentBody || typeof commentBody !== 'string' || !commentBody.trim()) {
    return apiResponse.badRequest(res, 'Comment body is required');
  }

  // Verify document belongs to company and is not locked
  const docs = (await sql`
    SELECT id, status FROM afs_documents
    WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Array<{ id: string; status: string }>;

  if (docs.length === 0) return apiResponse.notFound(res, 'Document', documentId);

  const doc = docs[0]!;
  if (doc.status === 'signed_off' || doc.status === 'filed') {
    return apiResponse.badRequest(res, 'Annotations are disabled on signed or filed documents');
  }

  // Verify section belongs to this document and company (IDOR guard)
  const sections = await sql`
    SELECT id FROM afs_sections
    WHERE id = ${sectionId}::UUID
      AND document_id = ${documentId}::UUID
      AND company_id = ${companyId}::UUID
    LIMIT 1
  `;
  if (sections.length === 0) return apiResponse.notFound(res, 'Section', sectionId);

  // Insert comment with author_type = 'portal'
  const inserted = (await sql`
    INSERT INTO afs_section_comments (section_id, company_id, author_id, author_type, body)
    VALUES (${sectionId}::UUID, ${companyId}::UUID, ${contactId}::UUID, 'portal', ${commentBody.trim()})
    RETURNING id
  `) as Array<{ id: string }>;

  const commentId = inserted[0]!.id;

  // Load contact name for notification
  const contactRows = (await sql`
    SELECT name FROM portal_contacts
    WHERE id = ${contactId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Array<{ name: string }>;
  const authorName = contactRows.length > 0 ? contactRows[0]!.name : 'Portal contact';

  await notifyAnnotationReceived(companyId, sectionId, authorName);

  log.info(
    'Portal annotation created',
    { companyId, documentId, sectionId, commentId, contactId },
    'portal-annotate-api',
  );
  return apiResponse.created(res, { commentId }, 'Annotation saved');
}

export default withPortalAuth(withErrorHandler(handler as never) as never);
