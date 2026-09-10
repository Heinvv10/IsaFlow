// src/modules/accounting/services/afs/afsSectionAttestation.ts
//
// A section's review or sign-off attests to specific content. Every write that changes a
// section goes through here: it is bound to the document the request names, it is refused
// while that document is signed off or filed, and a content change voids the attestation
// that covered the old content — visibly, in the audit log a reviewer reads.
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { assertIndependentRequestReview } from '@/modules/accounting/services/controls/independentReview';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { ReviewError } from './afsReviewError';
import type { SectionStatus } from './afsTypes';

/** Postgres `lock_not_available` — the `lock_timeout` elapsed waiting for a row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * A wedged peer must surface as a retryable refusal rather than pin one of the ten shared pool
 * connections. Re-issued on every call: SET LOCAL is subtransaction-aware, so a savepoint
 * rollback restores `0` (no timeout at all) — see bankTxLock for the same reasoning.
 * Outside a request transaction SET LOCAL would only warn, so it is skipped there.
 */
export async function setLockTimeout(): Promise<void> {
  const client = als.getStore()?.client;
  if (client) await client.query("SET LOCAL lock_timeout = '5s'");
}

export function asLockTimeout(err: unknown, what: string): unknown {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === LOCK_NOT_AVAILABLE
    ? new ReviewError(`${what} is being changed by another request — retry in a moment.`, 'LOCK_TIMEOUT')
    : err;
}

export { ReviewError };

/**
 * A review, a sign-off, or the voiding of either is a person's decision. An impersonated session
 * holds the member's identity, so it must be refused here rather than recorded as that member.
 * Raised as a ReviewError so routes answer 403 instead of 500.
 */
export function assertPersonalReview(): void {
  try {
    assertIndependentRequestReview();
  } catch (err) {
    throw new ReviewError(err instanceof Error ? err.message : String(err), 'IMPERSONATED');
  }
}

export interface LockedSection {
  id: string;
  documentId: string;
  sectionType: string;
  status: SectionStatus;
  reviewedBy: string | null;
  signedOffBy: string | null;
}

/**
 * Locks the section row, and its document's row, for a write. The section must belong to
 * `documentId` — the document named in the request — and that document must be editable.
 * Inside a request transaction the locks hold until commit, so a review or a document
 * sign-off committing concurrently is decided on, not overwritten.
 */
export async function lockSectionForWrite(
  companyId: string,
  documentId: string,
  sectionId: string,
): Promise<LockedSection> {
  await setLockTimeout();
  let rows: Record<string, unknown>[];
  try {
    // FOR UPDATE OF s serialises writers of this section; FOR SHARE OF d lets other sections of
    // the same document be written at the same time while still conflicting with the FOR UPDATE
    // a document transition takes — so a sign-off cannot slip between this read and its write.
    rows = (await sql`
      SELECT s.id, s.document_id, s.section_type, s.status, s.reviewed_by, s.signed_off_by,
             d.status AS document_status, d.signing_requested_at
      FROM afs_sections s
      JOIN afs_documents d ON d.id = s.document_id AND d.company_id = ${companyId}::UUID
      WHERE s.id          = ${sectionId}::UUID
        AND s.document_id = ${documentId}::UUID
        AND s.company_id  = ${companyId}::UUID
      FOR UPDATE OF s
      FOR SHARE OF d
    `) as Record<string, unknown>[];
  } catch (err) {
    throw asLockTimeout(err, 'This AFS section');
  }
  const row = rows[0];
  if (!row) throw new ReviewError('Section not found', 'NOT_FOUND');
  if (row.document_status === 'signed_off' || row.document_status === 'filed') {
    throw new ReviewError('Document is locked — no edits allowed', 'DOCUMENT_LOCKED');
  }
  // Out for signature: the signatories are signing the content as it stands, so it may not move
  // under them. The webhook hands the document back if it changed anyway.
  if (row.signing_requested_at != null) {
    throw new ReviewError('Document is out for signature — no edits until signing completes', 'DOCUMENT_LOCKED');
  }
  return {
    id: row.id as string,
    documentId: row.document_id as string,
    sectionType: row.section_type as string,
    status: row.status as SectionStatus,
    reviewedBy: (row.reviewed_by as string | null) ?? null,
    signedOffBy: (row.signed_off_by as string | null) ?? null,
  };
}

/** True while a review or sign-off stands on the section's current content. */
export const isSectionAttested = (s: Pick<LockedSection, 'status' | 'reviewedBy' | 'signedOffBy'>): boolean =>
  s.status === 'reviewed' || s.status === 'signed_off' || s.reviewedBy !== null || s.signedOffBy !== null;

/**
 * Voids the review and sign-off of a section whose content is about to change: a reviewed or
 * signed-off section drops to 'pending', a lower status is kept, and the reviewer, signatory
 * and their timestamps are cleared either way. Writes an audit row naming what was voided and
 * why. Returns false, writing nothing, when the section carried no attestation.
 *
 * Call after lockSectionForWrite and before the content write.
 */
export async function voidSectionAttestation(
  companyId: string,
  section: LockedSection,
  userId: string,
  reason: string,
): Promise<boolean> {
  if (!isSectionAttested(section)) return false;
  // Dropping a review is a change of review state; an impersonated session may not make it.
  assertPersonalReview();

  // Decided in SQL on the row as it stands, so even a caller without an enclosing
  // transaction never carries a review onto changed content.
  const rows = (await sql`
    WITH prior AS (
      SELECT id, status, reviewed_by, signed_off_by
      FROM afs_sections
      WHERE id = ${section.id}::UUID AND document_id = ${section.documentId}::UUID AND company_id = ${companyId}::UUID
      FOR UPDATE
    )
    UPDATE afs_sections s
    SET status        = CASE WHEN prior.status IN ('reviewed', 'signed_off') THEN 'pending' ELSE prior.status END,
        reviewed_by   = NULL,
        reviewed_at   = NULL,
        signed_off_by = NULL,
        signed_off_at = NULL,
        updated_at    = now()
    FROM prior
    WHERE s.id = prior.id
      AND s.company_id = ${companyId}::UUID
      AND (prior.status IN ('reviewed', 'signed_off') OR prior.reviewed_by IS NOT NULL OR prior.signed_off_by IS NOT NULL)
    RETURNING prior.status AS old_status, prior.reviewed_by AS old_reviewed_by,
              prior.signed_off_by AS old_signed_off_by, s.status AS new_status
  `) as Record<string, unknown>[];
  const row = rows[0];
  if (!row) return false;

  await logAuditOrThrow({
    companyId,
    userId,
    action: 'update',
    entityType: 'afs_section',
    entityId: section.id,
    entityRef: section.sectionType.slice(0, 100),
    changes: {
      fields: [
        { field: 'status', old: row.old_status as string, new: row.new_status as string, label: 'Review status' },
        { field: 'reviewed_by', old: (row.old_reviewed_by as string | null) ?? null, new: null, label: 'Reviewed by' },
        { field: 'signed_off_by', old: (row.old_signed_off_by as string | null) ?? null, new: null, label: 'Signed off by' },
      ],
      metadata: { reason, documentId: section.documentId, event: 'afs_section_review_invalidated' },
    },
  });

  log.info('Section review invalidated by a content change', {
    companyId, documentId: section.documentId, sectionId: section.id, userId, reason, priorStatus: row.old_status,
  }, 'afsSectionAttestation');
  return true;
}
