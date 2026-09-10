// src/modules/accounting/services/afs/afsDocumentTransitions.ts
//
// Moving a document (submit → in_review, promote → partner_review, sign off → signed_off) is a
// decision about its sections. Every transition therefore takes the document's row lock BEFORE
// it counts anything: a section write in flight either committed before the lock and is counted,
// or waits behind it and is refused afterwards by the guard, which sees the moved document. The
// UPDATE repeats the status it decided on, so a transition can never move a document twice.
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { assertPersonalReview, asLockTimeout, setLockTimeout } from './afsSectionAttestation';
import { ReviewError } from './afsReviewError';
import type { DocumentStatus, SectionStatus } from './afsTypes';
import { SECTION_STATUS_ORDER } from './afsTypes';

export interface LockedDocument {
  id: string;
  status: DocumentStatus;
  signingRequestedAt: Date | null;
}

/** Reads the document and holds its row until the request commits. */
export async function lockDocumentForTransition(
  companyId: string,
  documentId: string,
): Promise<LockedDocument> {
  await setLockTimeout();
  let rows: Record<string, unknown>[];
  try {
    rows = (await sql`
      SELECT id, status, signing_requested_at
      FROM afs_documents
      WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
      FOR UPDATE
    `) as Record<string, unknown>[];
  } catch (err) {
    throw asLockTimeout(err, 'This AFS document');
  }
  const row = rows[0];
  if (!row) throw new ReviewError('Document not found', 'NOT_FOUND');
  return {
    id: row.id as string,
    status: row.status as DocumentStatus,
    signingRequestedAt: (row.signing_requested_at as Date | null) ?? null,
  };
}

/**
 * Counts mandatory sections below a status threshold. Primary statement sections with no
 * template row are always mandatory.
 */
export async function countMandatorySectionsBelow(
  companyId: string,
  documentId: string,
  minStatus: SectionStatus,
): Promise<number> {
  // One template row per section type PER FRAMEWORK: joining on the type alone counts a
  // section up to three times and reads mandatory-ness from a framework this document is not
  // prepared under. The lateral takes the row registered for the document's own framework,
  // then the 'both' row, and treats a type with no row at all as mandatory.
  const rows = (await sql`
    SELECT COUNT(*)::int AS cnt
    FROM afs_sections s
    JOIN afs_documents d ON d.id = s.document_id AND d.company_id = ${companyId}::UUID
    LEFT JOIN LATERAL (
      SELECT nt.is_mandatory
      FROM note_templates nt
      WHERE nt.section_type = s.section_type
        AND nt.framework IN (d.reporting_framework, 'both')
      ORDER BY (nt.framework = d.reporting_framework) DESC
      LIMIT 1
    ) nt ON TRUE
    WHERE s.document_id = ${documentId}::UUID
      AND s.company_id = ${companyId}::UUID
      AND COALESCE(nt.is_mandatory, TRUE)
      AND CASE s.status
            WHEN 'pending'        THEN 0
            WHEN 'auto_generated' THEN 1
            WHEN 'ai_enhanced'    THEN 2
            WHEN 'reviewed'       THEN 3
            WHEN 'signed_off'     THEN 4
          END < ${SECTION_STATUS_ORDER[minStatus]}
  `) as Record<string, unknown>[];
  return Number(rows[0]?.cnt ?? 0);
}

export async function countUnresolvedCommentsForDocument(
  companyId: string,
  documentId: string,
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

/** Applies the decided transition, repeating the status it was decided on. */
async function applyTransition(
  companyId: string,
  documentId: string,
  from: DocumentStatus,
  to: DocumentStatus,
  locking: { userId: string } | null,
): Promise<void> {
  const rows = (await sql`
    UPDATE afs_documents
    SET status     = ${to},
        locked_at  = CASE WHEN ${locking !== null} THEN now() ELSE locked_at END,
        locked_by  = CASE WHEN ${locking !== null} THEN ${locking?.userId ?? null}::TEXT ELSE locked_by END,
        updated_at = now()
    WHERE id = ${documentId}::UUID
      AND company_id = ${companyId}::UUID
      AND status = ${from}
    RETURNING id
  `) as Record<string, unknown>[];
  if (rows.length === 0) {
    throw new ReviewError(`Cannot move document: its status is no longer '${from}'`, 'INVALID_TRANSITION');
  }
}

export async function submitDocumentForReview(
  companyId: string,
  documentId: string,
  userId: string,
): Promise<{ documentId: string; newStatus: DocumentStatus }> {
  const doc = await lockDocumentForTransition(companyId, documentId);
  if (doc.status !== 'draft') {
    throw new ReviewError(`Cannot submit: document status is '${doc.status}', expected 'draft'`, 'INVALID_TRANSITION');
  }

  const belowCount = await countMandatorySectionsBelow(companyId, documentId, 'reviewed');
  if (belowCount > 0) {
    throw new ReviewError(`Cannot submit: ${belowCount} mandatory section(s) not yet reviewed`, 'SECTIONS_NOT_READY');
  }

  await applyTransition(companyId, documentId, 'draft', 'in_review', null);
  log.info('Document submitted for review', { documentId, companyId, userId }, 'afsDocumentTransitions');
  return { documentId, newStatus: 'in_review' };
}

export async function promoteToPartnerReview(
  companyId: string,
  documentId: string,
  userId: string,
): Promise<{ documentId: string; newStatus: DocumentStatus }> {
  const doc = await lockDocumentForTransition(companyId, documentId);
  if (doc.status !== 'in_review') {
    throw new ReviewError(`Cannot promote: document status is '${doc.status}', expected 'in_review'`, 'INVALID_TRANSITION');
  }

  const belowCount = await countMandatorySectionsBelow(companyId, documentId, 'reviewed');
  if (belowCount > 0) {
    throw new ReviewError(`Cannot promote: ${belowCount} mandatory section(s) not yet reviewed`, 'SECTIONS_NOT_READY');
  }
  const unresolved = await countUnresolvedCommentsForDocument(companyId, documentId);
  if (unresolved > 0) {
    throw new ReviewError(`Cannot promote: ${unresolved} unresolved comment(s)`, 'UNRESOLVED_COMMENTS');
  }

  await applyTransition(companyId, documentId, 'in_review', 'partner_review', null);
  log.info('Document promoted to partner review', { documentId, companyId, userId }, 'afsDocumentTransitions');
  return { documentId, newStatus: 'partner_review' };
}

export async function signOffDocument(
  companyId: string,
  documentId: string,
  userId: string,
): Promise<{ documentId: string; newStatus: DocumentStatus }> {
  assertPersonalReview();
  const doc = await lockDocumentForTransition(companyId, documentId);
  if (doc.status !== 'partner_review' && doc.status !== 'in_review') {
    throw new ReviewError(
      `Cannot sign off: document status is '${doc.status}', expected 'in_review' or 'partner_review'`,
      'INVALID_TRANSITION',
    );
  }

  const unresolved = await countUnresolvedCommentsForDocument(companyId, documentId);
  if (unresolved > 0) {
    throw new ReviewError(`Cannot sign off: ${unresolved} unresolved comment(s)`, 'UNRESOLVED_COMMENTS');
  }

  const belowCount = await countMandatorySectionsBelow(companyId, documentId, 'signed_off');
  if (belowCount > 0) {
    throw new ReviewError(`Cannot sign off: ${belowCount} mandatory section(s) not yet signed off`, 'SECTIONS_NOT_READY');
  }

  await applyTransition(companyId, documentId, doc.status, 'signed_off', { userId });

  // Signing off is what releases a pack that was generated without review: it is the human
  // attestation the hold was waiting for, and the release is recorded where a reviewer reads it.
  const released = (await sql`
    UPDATE afs_documents
    SET delivery_withheld_reason = NULL, updated_at = now()
    WHERE id = ${documentId}::UUID
      AND company_id = ${companyId}::UUID
      AND delivery_withheld_reason IS NOT NULL
    RETURNING id
  `) as Record<string, unknown>[];
  if (released.length > 0) {
    await logAuditOrThrow({
      companyId,
      userId,
      action: 'approve',
      entityType: 'afs_document',
      entityId: documentId,
      changes: {
        fields: [{ field: 'delivery_withheld_reason', old: 'withheld', new: null, label: 'Delivery hold' }],
        metadata: { reason: 'Released for delivery by document sign-off', event: 'afs_pack_delivery_released' },
      },
    });
  }

  log.info('Document signed off', { documentId, companyId, userId, deliveryReleased: released.length > 0 }, 'afsDocumentTransitions');
  return { documentId, newStatus: 'signed_off' };
}
