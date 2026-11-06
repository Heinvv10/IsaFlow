/**
 * Captured documents linked to a bank line (captured_documents.matched_bank_tx_id) as attachments of that line.
 *
 * Linking a captured document copies it into bank_transaction_attachments only up to 2 MB (captureBankTxAttachService);
 * a larger one, or one whose copy failed, was linked but invisible: the line read "No attachments". These are listed
 * and counted beside the copies, and their bytes are served by pages/api/accounting/captured-document-file.ts.
 *
 * A document that WAS copied is not listed twice: its copy's file_name starts with "<document id>_" (the copy's
 * provenance key, see captureBankTxAttachService). A document with no stored bytes cannot be opened, so it is not
 * counted either.
 */
import { sql } from '@/lib/neon';
import { mimeForCapturedFileType } from './captureBankTxAttachService';

/**
 * The attachment count of the bank line aliased `bt`, for a SELECT list: its copies plus its linked captured documents
 * that have no copy. A constant built from a fixed alias, so safe for sql.unsafe. Tenant scope: copies are reached only
 * through bt.id; captured documents carry their own company_id, which must equal bt's.
 */
export function attachmentCountSql(bt: 'bt'): string {
  return `(
    (SELECT COUNT(*)::INT FROM bank_transaction_attachments bta WHERE bta.bank_transaction_id = ${bt}.id)
    + (SELECT COUNT(*)::INT FROM captured_documents cd
        WHERE cd.matched_bank_tx_id = ${bt}.id AND cd.company_id = ${bt}.company_id AND cd.storage_path IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM bank_transaction_attachments m
                           WHERE m.bank_transaction_id = ${bt}.id AND left(m.file_name, 37) = cd.id::text || '_'))
  )`;
}

/** A linked captured document in the shape of a bank_transaction_attachments row, plus where it came from. */
export interface LinkedCapturedAttachment {
  id: string;
  bank_transaction_id: string;
  file_url: string;
  file_name: string;
  file_size: number | null;
  uploaded_by: null;
  created_at: string | Date;
  source: 'captured';
  /** The type the document claims. The viewer trusts only its bytes; this decides View and the download extension. */
  content_type: string | null;
}

export const capturedFileUrl = (documentId: string): string =>
  `/api/accounting/captured-document-file?id=${documentId}`;

/** The bank line must already be verified as this company's. */
export async function listLinkedCapturedAttachments(
  companyId: string,
  bankTxId: string,
): Promise<LinkedCapturedAttachment[]> {
  const rows = (await sql`
    SELECT cd.id, cd.file_name, cd.file_type, COALESCE(cd.raw_bytes_size, cd.file_size) AS size, cd.created_at
      FROM captured_documents cd
     WHERE cd.matched_bank_tx_id = ${bankTxId}::uuid AND cd.company_id = ${companyId}::uuid
       AND cd.storage_path IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM bank_transaction_attachments m
                        WHERE m.bank_transaction_id = ${bankTxId}::uuid AND left(m.file_name, 37) = cd.id::text || '_')
     ORDER BY cd.created_at DESC
  `) as Array<{ id: string; file_name: string | null; file_type: string | null; size: number | null; created_at: string | Date }>;
  return rows.map((r) => ({
    id: `captured-${r.id}`,
    bank_transaction_id: bankTxId,
    file_url: capturedFileUrl(r.id),
    file_name: r.file_name ?? 'document',
    file_size: r.size,
    uploaded_by: null,
    created_at: r.created_at,
    source: 'captured',
    content_type: r.file_type ? mimeForCapturedFileType(r.file_type) : null,
  }));
}
