// src/modules/accounting/services/afs/afsReviewService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertPersonalReview, lockSectionForWrite } from './afsSectionAttestation';
import { ReviewError } from './afsReviewError';
import type { SectionStatus, DocumentStatus } from './afsTypes';

export { ReviewError } from './afsReviewError';
export type { ReviewErrorCode } from './afsReviewError';
// Document transitions live next door; re-exported so callers keep one entry point.
export {
  countMandatorySectionsBelow,
  countUnresolvedCommentsForDocument,
  lockDocumentForTransition,
  promoteToPartnerReview,
  signOffDocument,
  submitDocumentForReview,
} from './afsDocumentTransitions';

// ── Internal helpers ────────────────────────────────────────────────────────

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

async function getDocument(companyId: string, documentId: string): Promise<{ id: string; status: DocumentStatus } | null> {
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
  assertPersonalReview();
  // Bound to the document in the request, refused while it is locked or out for signature, and
  // held against a concurrent document transition until this request commits.
  await lockSectionForWrite(companyId, documentId, sectionId);

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
  assertPersonalReview();
  await lockSectionForWrite(companyId, documentId, sectionId);

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
