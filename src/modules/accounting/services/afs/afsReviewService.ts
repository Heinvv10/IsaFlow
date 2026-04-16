// src/modules/accounting/services/afs/afsReviewService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { SectionStatus, DocumentStatus } from './afsTypes';
import { SECTION_STATUS_ORDER } from './afsTypes';

// ── Error ───────────────────────────────────────────────────────────────────

export class ReviewError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'UNRESOLVED_COMMENTS'
      | 'SECTIONS_NOT_READY'
      | 'DOCUMENT_LOCKED'
      | 'INVALID_TRANSITION'
      | 'NOT_FOUND'
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

interface SectionRow {
  id: string;
  document_id: string;
  status: SectionStatus;
}

interface DocumentRow {
  id: string;
  status: DocumentStatus;
}

async function getSectionWithDocument(
  companyId: string,
  sectionId: string
): Promise<{ section: SectionRow | null; document: DocumentRow | null }> {
  const rows = (await sql`
    SELECT
      s.id            AS section_id,
      s.document_id,
      s.status        AS section_status,
      d.id            AS doc_id,
      d.status        AS doc_status
    FROM afs_sections s
    JOIN afs_documents d ON d.id = s.document_id AND d.company_id = ${companyId}
    WHERE s.id = ${sectionId}
      AND s.company_id = ${companyId}
  `) as Record<string, unknown>[];

  const r = rows[0];
  if (!r) return { section: null, document: null };
  return {
    section: { id: r.section_id as string, document_id: r.document_id as string, status: r.section_status as SectionStatus },
    document: { id: r.doc_id as string, status: r.doc_status as DocumentStatus },
  };
}

async function countUnresolvedComments(
  companyId: string,
  sectionId: string
): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS cnt
    FROM afs_section_comments
    WHERE section_id = ${sectionId}
      AND company_id = ${companyId}
      AND resolved = FALSE
  `) as Record<string, unknown>[];
  const first = rows[0];
  return first !== undefined ? (first.cnt as number) ?? 0 : 0;
}

async function countUnresolvedCommentsForDocument(
  companyId: string,
  documentId: string
): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS n
    FROM afs_section_comments c
    JOIN afs_sections s ON s.id = c.section_id
    WHERE c.company_id = ${companyId}::UUID
      AND s.company_id = ${companyId}::UUID
      AND s.document_id = ${documentId}::UUID
      AND c.resolved = FALSE
  `) as Record<string, unknown>[];
  return Number(rows[0]?.n ?? 0);
}

// Counts mandatory sections below a given status threshold.
// Primary statement sections with no template row are always mandatory.
async function countMandatorySectionsBelow(
  companyId: string,
  documentId: string,
  minStatus: SectionStatus
): Promise<number> {
  const minOrder = SECTION_STATUS_ORDER[minStatus];

  const rows = (await sql`
    SELECT COUNT(*)::int AS cnt
    FROM afs_sections s
    LEFT JOIN note_templates nt
      ON nt.section_type = s.section_type
    WHERE s.document_id = ${documentId}
      AND s.company_id = ${companyId}
      AND (nt.is_mandatory = TRUE OR nt.id IS NULL)
      AND CASE s.status
            WHEN 'pending'        THEN 0
            WHEN 'auto_generated' THEN 1
            WHEN 'ai_enhanced'    THEN 2
            WHEN 'reviewed'       THEN 3
            WHEN 'signed_off'     THEN 4
          END < ${minOrder}
  `) as Record<string, unknown>[];
  const first = rows[0];
  return first !== undefined ? (first.cnt as number) ?? 0 : 0;
}

async function getDocument(companyId: string, documentId: string): Promise<DocumentRow | null> {
  const rows = (await sql`
    SELECT id, status FROM afs_documents
    WHERE id = ${documentId} AND company_id = ${companyId}
  `) as Record<string, unknown>[];
  const r = rows[0];
  return r ? { id: r.id as string, status: r.status as DocumentStatus } : null;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function markSectionReviewed(
  companyId: string,
  documentId: string,
  sectionId: string,
  userId: string
): Promise<{ sectionId: string; newStatus: SectionStatus }> {
  const { section, document } = await getSectionWithDocument(companyId, sectionId);

  if (!section || !document || document.id !== documentId) {
    throw new ReviewError('Section not found', 'NOT_FOUND');
  }

  if (document.status === 'signed_off' || document.status === 'filed') {
    throw new ReviewError('Document is locked — no edits allowed', 'DOCUMENT_LOCKED');
  }

  await sql`
    UPDATE afs_sections
    SET status = 'reviewed',
        reviewed_by = ${userId},
        reviewed_at = now(),
        updated_at = now()
    WHERE id = ${sectionId}
      AND document_id = ${documentId}
      AND company_id = ${companyId}
  `;

  log.info('Section marked reviewed', { sectionId, documentId, companyId, userId }, 'afsReviewService');
  return { sectionId, newStatus: 'reviewed' };
}

export async function signOffSection(
  companyId: string,
  documentId: string,
  sectionId: string,
  userId: string
): Promise<{ sectionId: string; newStatus: SectionStatus }> {
  const { section, document } = await getSectionWithDocument(companyId, sectionId);

  if (!section || !document || document.id !== documentId) {
    throw new ReviewError('Section not found', 'NOT_FOUND');
  }

  if (document.status === 'signed_off' || document.status === 'filed') {
    throw new ReviewError('Document is locked — no edits allowed', 'DOCUMENT_LOCKED');
  }

  const unresolvedCount = await countUnresolvedComments(companyId, sectionId);
  if (unresolvedCount > 0) {
    throw new ReviewError(
      `Cannot sign off: ${unresolvedCount} unresolved comment(s) on this section`,
      'UNRESOLVED_COMMENTS'
    );
  }

  await sql`
    UPDATE afs_sections
    SET status = 'signed_off',
        signed_off_by = ${userId},
        signed_off_at = now(),
        updated_at = now()
    WHERE id = ${sectionId}
      AND document_id = ${documentId}
      AND company_id = ${companyId}
  `;

  log.info('Section signed off', { sectionId, documentId, companyId, userId }, 'afsReviewService');
  return { sectionId, newStatus: 'signed_off' };
}

export async function submitDocumentForReview(
  companyId: string,
  documentId: string,
  userId: string
): Promise<{ documentId: string; newStatus: DocumentStatus }> {
  const doc = await getDocument(companyId, documentId);
  if (!doc) throw new ReviewError('Document not found', 'NOT_FOUND');

  if (doc.status !== 'draft') {
    throw new ReviewError(
      `Cannot submit: document status is '${doc.status}', expected 'draft'`,
      'INVALID_TRANSITION'
    );
  }

  const belowCount = await countMandatorySectionsBelow(companyId, documentId, 'reviewed');
  if (belowCount > 0) {
    throw new ReviewError(
      `Cannot submit: ${belowCount} mandatory section(s) not yet reviewed`,
      'SECTIONS_NOT_READY'
    );
  }

  await sql`
    UPDATE afs_documents
    SET status = 'in_review',
        updated_at = now()
    WHERE id = ${documentId}
      AND company_id = ${companyId}
  `;

  log.info('Document submitted for review', { documentId, companyId, userId }, 'afsReviewService');
  return { documentId, newStatus: 'in_review' };
}

export async function signOffDocument(
  companyId: string,
  documentId: string,
  userId: string
): Promise<{ documentId: string; newStatus: DocumentStatus }> {
  const doc = await getDocument(companyId, documentId);
  if (!doc) throw new ReviewError('Document not found', 'NOT_FOUND');

  if (doc.status !== 'partner_review' && doc.status !== 'in_review') {
    throw new ReviewError(
      `Cannot sign off: document status is '${doc.status}', expected 'in_review' or 'partner_review'`,
      'INVALID_TRANSITION'
    );
  }

  const unresolved = await countUnresolvedCommentsForDocument(companyId, documentId);
  if (unresolved > 0) {
    throw new ReviewError(
      `Cannot sign off: ${unresolved} unresolved comment(s)`,
      'UNRESOLVED_COMMENTS'
    );
  }

  const belowCount = await countMandatorySectionsBelow(companyId, documentId, 'signed_off');
  if (belowCount > 0) {
    throw new ReviewError(
      `Cannot sign off: ${belowCount} mandatory section(s) not yet signed off`,
      'SECTIONS_NOT_READY'
    );
  }

  await sql`
    UPDATE afs_documents
    SET status = 'signed_off',
        locked_at = now(),
        locked_by = ${userId},
        updated_at = now()
    WHERE id = ${documentId}
      AND company_id = ${companyId}
  `;

  log.info('Document signed off', { documentId, companyId, userId }, 'afsReviewService');
  return { documentId, newStatus: 'signed_off' };
}

export async function promoteToPartnerReview(
  companyId: string,
  documentId: string,
  userId: string
): Promise<{ documentId: string; newStatus: DocumentStatus }> {
  const doc = await getDocument(companyId, documentId);
  if (!doc) throw new ReviewError('Document not found', 'NOT_FOUND');

  if (doc.status !== 'in_review') {
    throw new ReviewError(
      `Cannot promote: document status is '${doc.status}', expected 'in_review'`,
      'INVALID_TRANSITION'
    );
  }

  // Require all mandatory sections to be at least 'reviewed'
  const belowCount = await countMandatorySectionsBelow(companyId, documentId, 'reviewed');
  if (belowCount > 0) {
    throw new ReviewError(
      `Cannot promote: ${belowCount} mandatory section(s) not yet reviewed`,
      'SECTIONS_NOT_READY'
    );
  }
  // Require zero unresolved comments across the document
  const unresolved = await countUnresolvedCommentsForDocument(companyId, documentId);
  if (unresolved > 0) {
    throw new ReviewError(
      `Cannot promote: ${unresolved} unresolved comment(s)`,
      'UNRESOLVED_COMMENTS'
    );
  }

  await sql`
    UPDATE afs_documents
    SET status = 'partner_review',
        updated_at = now()
    WHERE id = ${documentId}
      AND company_id = ${companyId}
  `;

  log.info('Document promoted to partner review', { documentId, companyId, userId }, 'afsReviewService');
  return { documentId, newStatus: 'partner_review' };
}

export async function assertDocumentEditable(
  companyId: string,
  documentId: string
): Promise<void> {
  const doc = await getDocument(companyId, documentId);
  if (!doc) throw new ReviewError('Document not found', 'NOT_FOUND');

  if (doc.status === 'signed_off' || doc.status === 'filed') {
    throw new ReviewError('Document is locked — no edits allowed', 'DOCUMENT_LOCKED');
  }
}
