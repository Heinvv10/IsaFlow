// src/modules/accounting/services/afs/portalDocumentService.ts
// What a verified portal session may read of the AFS documents. The portal API routes and the portal pages'
// getServerSideProps both call these, so the access rules (PORTAL_ACCESS_RULES) have one implementation and a page
// never has to fetch its own API. The caller has already verified the session (withPortalAuth, or
// verifyPortalToken + currentPortalSession) and passes its company and CURRENT role; every query is scoped to it.

import { sql } from '@/lib/neon';
import { PORTAL_ACCESS_RULES, type PortalSession } from './afsTypes';

type Row = Record<string, unknown>;
type Role = PortalSession['role'];

export type PortalDocumentOutcome =
  | { kind: 'ok'; document: Row; sections: Row[] }
  | { kind: 'not_found' }
  | { kind: 'forbidden'; message: string };

/** The documents the role may see: its document types, and (when the role is limited to some) its statuses. */
export async function listPortalDocuments(companyId: string, role: Role): Promise<Row[]> {
  const { documentTypes, statuses } = PORTAL_ACCESS_RULES[role];
  return (await sql`
    SELECT id, fiscal_year, period, document_type, status, created_at, updated_at
    FROM afs_documents
    WHERE company_id = ${companyId}::UUID
      AND document_type = ANY(${documentTypes}::TEXT[])
      AND (${statuses.length === 0} OR status = ANY(${statuses}::TEXT[]))
    ORDER BY created_at DESC
  `) as Row[];
}

/** One document and its sections, when the role may see its type and status. A malformed id throws (the uuid cast). */
export async function loadPortalDocument(companyId: string, role: Role, documentId: string): Promise<PortalDocumentOutcome> {
  const docs = (await sql`
    SELECT id, fiscal_year, period, document_type, status, signing_requested_at, created_at, updated_at
    FROM afs_documents
    WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Array<{ id: string; document_type: string; status: string } & Row>;
  const doc = docs[0];
  if (!doc) return { kind: 'not_found' };

  const rules = PORTAL_ACCESS_RULES[role];
  if (!rules.documentTypes.includes(doc.document_type as 'afs' | 'management_pack')) {
    return { kind: 'forbidden', message: 'You do not have access to this document type' };
  }
  if (rules.statuses.length > 0 && !rules.statuses.includes(doc.status)) {
    return { kind: 'forbidden', message: 'You do not have access to this document in its current status' };
  }

  // Sections without version_history, for payload size.
  const sections = (await sql`
    SELECT id, section_type, sort_order, status, content, overrides, ai_narrative, ai_narrative_accepted, created_at, updated_at
    FROM afs_sections
    WHERE document_id = ${documentId}::UUID AND company_id = ${companyId}::UUID
    ORDER BY sort_order ASC
  `) as Row[];
  return { kind: 'ok', document: doc, sections };
}
