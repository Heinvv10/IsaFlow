// src/modules/accounting/services/afs/afsSigningIntegrity.ts
//
// What the signatories sign is the document as it stood when it was sent. The send records a
// fingerprint over every section's content AND review state; the signature webhook signs the
// document off only while that fingerprint still holds and every mandatory section is still
// signed off. Anything else is a signature over content the database no longer holds, so it is
// refused, the reason recorded, and the document handed back for a fresh send.
import { log } from '@/lib/logger';

/** A tagged-template query: the request-bound `sql`, or a `withTransaction` tx. */
export type Query = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

/**
 * sha256 over every section of the document: identity, order, status, signatory, and every
 * field that reaches the rendered statements. Any of them changing changes the fingerprint.
 */
export async function documentContentFingerprint(
  q: Query,
  companyId: string,
  documentId: string,
): Promise<string> {
  const rows = (await q`
    SELECT encode(sha256(convert_to(COALESCE(string_agg(
      concat_ws('|', s.id::text, s.sort_order::text, s.status, COALESCE(s.signed_off_by, ''),
                COALESCE(s.content::text, ''), COALESCE(s.overrides::text, ''),
                COALESCE(s.ai_narrative, ''), s.ai_narrative_accepted::text,
                COALESCE(s.data_snapshot::text, '')),
      E'\n' ORDER BY s.id), ''), 'UTF8')), 'hex') AS fingerprint
    FROM afs_sections s
    WHERE s.document_id = ${documentId}::UUID
      AND s.company_id = ${companyId}::UUID
  `) as Record<string, unknown>[];
  return String(rows[0]?.fingerprint ?? '');
}

/** Null when the document may be signed as it stands; otherwise why it may not. */
export async function signatureRefusalReason(
  q: Query,
  companyId: string,
  documentId: string,
  fingerprintAtSend: string | null,
): Promise<string | null> {
  if (!fingerprintAtSend) return 'No record of what was sent for signature';
  // Counted on the same connection as the fingerprint, so both see one state of the document.
  const counted = (await q`
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
      AND s.status <> 'signed_off'
  `) as Record<string, unknown>[];
  const notSignedOff = Number(counted[0]?.cnt ?? 0);
  if (notSignedOff > 0) return `${notSignedOff} mandatory section(s) are no longer signed off`;
  const current = await documentContentFingerprint(q, companyId, documentId);
  return current === fingerprintAtSend ? null : 'Section content changed after the document was sent for signature';
}

/**
 * Records the refusal and hands the document back: staff can correct the content and send again.
 * The document keeps its own status — it is not moved by a signature it did not earn.
 */
export async function recordSignatureRefusal(
  q: Query,
  companyId: string,
  documentId: string,
  reason: string,
): Promise<void> {
  await q`
    UPDATE afs_documents
    SET signing_refused_at          = now(),
        signing_refused_reason      = ${reason},
        signum_document_id          = NULL,
        signing_requested_at        = NULL,
        signing_content_fingerprint = NULL,
        updated_at                  = now()
    WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
  `;
  log.warn('Signature refused — the signed content is not the content held', { companyId, documentId, reason }, 'afsSigningIntegrity');
}
