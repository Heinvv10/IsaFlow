/**
 * The captured documents the provisional evidence attach would accept, for its picker
 * (GET /api/accounting/document-capture?attachable=1).
 *
 * "Attachable" mirrors what the attach itself checks, so the list offers nothing it then refuses:
 *  - claimCapturedDocumentForPosting: not posted, not rejected, read finished, and (spend 'evidence' ->
 *    findPostedContent) the same FILE (raw_bytes_sha256) not already posted from another document;
 *  - assertDocumentNotAlreadyPosted: not the source_document_id of a posted journal that still stands, and not
 *    the target of an active gl_journal_document_links row.
 * Plus only supplier evidence: not our own sent invoices, sent emails or dunning letters, and not a bank or supplier
 * statement (a supplier statement has no document_type; its reconciliation points at it).
 *
 * The rows query and the count query repeat one predicate; the paging test pins that they agree. It is written out
 * twice rather than shared as a fragment, because a nested `sql` fragment breaks the unit suites that mock `sql`
 * (see the header of shared/journalInForceAsAt.ts).
 */
import { sql } from '@/lib/neon';
import { journalStandsFragment } from '../shared/journalInForceAsAt';

export async function listAttachableDocuments(
  companyId: string,
  page: number,
  pageSize: number,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const offset = (page - 1) * pageSize;

  const rows = await sql`
    SELECT cd.* FROM captured_documents cd
    WHERE cd.company_id = ${companyId} AND cd.posted_at IS NULL AND cd.status <> 'rejected' AND cd.read_state = 'done'
      AND cd.document_type IS DISTINCT FROM 'sent_invoice' AND cd.document_type IS DISTINCT FROM 'outbound_email'
      AND cd.document_type IS DISTINCT FROM 'dunning' AND cd.document_type IS DISTINCT FROM 'statement'
      AND NOT EXISTS (SELECT 1 FROM bank_statement_imports b WHERE b.source_document_id = cd.id AND b.company_id = cd.company_id)
      AND NOT EXISTS (SELECT 1 FROM supplier_statement_reconciliations r
                      WHERE r.source_document_id = cd.id AND r.company_id = cd.company_id)
      AND NOT EXISTS (SELECT 1 FROM captured_documents p
                      WHERE p.company_id = cd.company_id AND p.id <> cd.id AND p.posted_at IS NOT NULL
                        AND cd.raw_bytes_sha256 IS NOT NULL AND p.raw_bytes_sha256 = cd.raw_bytes_sha256)
      AND NOT EXISTS (SELECT 1 FROM gl_journal_entries je
                      WHERE je.company_id = cd.company_id AND je.source_document_id = cd.id AND je.status = 'posted'
                        AND ${journalStandsFragment('je.id', companyId)})
      AND NOT EXISTS (SELECT 1 FROM gl_journal_document_links l
                      WHERE l.company_id = cd.company_id AND l.captured_document_id = cd.id AND l.unlinked_at IS NULL)
    ORDER BY cd.created_at DESC, cd.id DESC
    LIMIT ${pageSize} OFFSET ${offset}
  ` as Record<string, unknown>[];

  const countResult = await sql`
    SELECT COUNT(*)::int AS total FROM captured_documents cd
    WHERE cd.company_id = ${companyId} AND cd.posted_at IS NULL AND cd.status <> 'rejected' AND cd.read_state = 'done'
      AND cd.document_type IS DISTINCT FROM 'sent_invoice' AND cd.document_type IS DISTINCT FROM 'outbound_email'
      AND cd.document_type IS DISTINCT FROM 'dunning' AND cd.document_type IS DISTINCT FROM 'statement'
      AND NOT EXISTS (SELECT 1 FROM bank_statement_imports b WHERE b.source_document_id = cd.id AND b.company_id = cd.company_id)
      AND NOT EXISTS (SELECT 1 FROM supplier_statement_reconciliations r
                      WHERE r.source_document_id = cd.id AND r.company_id = cd.company_id)
      AND NOT EXISTS (SELECT 1 FROM captured_documents p
                      WHERE p.company_id = cd.company_id AND p.id <> cd.id AND p.posted_at IS NOT NULL
                        AND cd.raw_bytes_sha256 IS NOT NULL AND p.raw_bytes_sha256 = cd.raw_bytes_sha256)
      AND NOT EXISTS (SELECT 1 FROM gl_journal_entries je
                      WHERE je.company_id = cd.company_id AND je.source_document_id = cd.id AND je.status = 'posted'
                        AND ${journalStandsFragment('je.id', companyId)})
      AND NOT EXISTS (SELECT 1 FROM gl_journal_document_links l
                      WHERE l.company_id = cd.company_id AND l.captured_document_id = cd.id AND l.unlinked_at IS NULL)
  ` as Record<string, unknown>[];

  return { rows, total: (countResult[0]?.total as number) || 0 };
}
