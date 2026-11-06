/**
 * A bank line's attachments as the modal and drawer list them, and unlinking a captured document from the line.
 *
 * One item per document: an upload is listed as itself; a captured document linked to the line is listed ONCE, as its
 * copy when it has one (a data URL, shown at once) or else as a link to its stored bytes
 * (/api/accounting/captured-document-file). Which documents count is bank/bankLineDocumentSql, the one definition.
 * An item with document_id is a linked captured document: Remove unlinks it (Hein, 2026-11-06), it does not just
 * delete a copy, which would bring the document back as uncopied on the next read. Unlinking leaves its status alone.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { attachmentCountsSql, hasNoCopySql, isCopyOfSql, linkedCapturedDocSql } from '../bank/bankLineDocumentSql';
import { mimeForCapturedFileType } from './capturedFileTypes';
import { lockCapturedDocumentForUpdate } from './captureRowLock';

export interface BankLineAttachment {
  id: string;
  bank_transaction_id: string;
  file_url: string;
  file_name: string;
  file_size: number | null;
  uploaded_by: string | null;
  created_at: string | Date;
  /** Present on a linked captured document: the captured_documents id that Remove unlinks. */
  document_id?: string;
  source?: 'captured';
  /** The type a captured document claims; decides View and the download extension. The viewer trusts only bytes. */
  content_type?: string | null;
}

export const capturedFileUrl = (documentId: string): string =>
  `/api/accounting/captured-document-file?id=${documentId}`;

type Row = Record<string, unknown>;
const time = (v: unknown) => new Date(String(v instanceof Date ? v.toISOString() : v)).getTime();

/** Every supporting document of the bank line, newest first. The line must already be verified as this company's. */
export async function listBankLineAttachments(companyId: string, bankTxId: string): Promise<BankLineAttachment[]> {
  const copies = (await sql`
    SELECT bta.id, bta.bank_transaction_id, bta.file_url, bta.file_name, bta.file_size, bta.uploaded_by,
           bta.created_at, cd.id AS document_id, cd.file_type
      FROM bank_transaction_attachments bta
      JOIN bank_transactions bt ON bt.id = bta.bank_transaction_id
      LEFT JOIN captured_documents cd
        ON ${sql.unsafe(linkedCapturedDocSql('bt', 'cd'))} AND ${sql.unsafe(isCopyOfSql('bta', 'cd'))}
     WHERE bta.bank_transaction_id = ${bankTxId}::uuid AND bt.company_id = ${companyId}::uuid
       AND ${sql.unsafe(attachmentCountsSql('bta', 'bt'))}
  `) as Row[];
  const uncopied = (await sql`
    SELECT cd.id, cd.file_name, cd.file_type, COALESCE(cd.raw_bytes_size, cd.file_size) AS size, cd.created_at
      FROM captured_documents cd
      JOIN bank_transactions bt ON bt.id = cd.matched_bank_tx_id
     WHERE bt.id = ${bankTxId}::uuid AND bt.company_id = ${companyId}::uuid
       AND ${sql.unsafe(linkedCapturedDocSql('bt', 'cd'))} AND ${sql.unsafe(hasNoCopySql('bt', 'cd'))}
  `) as Row[];

  const items: BankLineAttachment[] = [
    ...copies.map((r): BankLineAttachment => ({
      id: String(r.id),
      bank_transaction_id: String(r.bank_transaction_id),
      file_url: String(r.file_url ?? ''),
      file_name: String(r.file_name ?? ''),
      file_size: r.file_size == null ? null : Number(r.file_size),
      uploaded_by: r.uploaded_by == null ? null : String(r.uploaded_by),
      created_at: r.created_at as string | Date,
      ...(r.document_id ? { document_id: String(r.document_id), source: 'captured' as const } : {}),
    })),
    ...uncopied.map((r): BankLineAttachment => ({
      id: `captured-${String(r.id)}`,
      bank_transaction_id: bankTxId,
      file_url: capturedFileUrl(String(r.id)),
      file_name: String(r.file_name ?? 'document'),
      file_size: r.size == null ? null : Number(r.size),
      uploaded_by: null,
      created_at: r.created_at as string | Date,
      document_id: String(r.id),
      source: 'captured',
      content_type: r.file_type ? mimeForCapturedFileType(String(r.file_type)) : null,
    })),
  ];
  return items.sort((a, b) => time(b.created_at) - time(a.created_at));
}

/** Whether this company's captured document is a supporting document of some bank line (the bytes route's gate). */
export async function isBankLinkedCapturedDocument(companyId: string, documentId: string): Promise<boolean> {
  const [row] = (await sql`
    SELECT 1 AS ok FROM captured_documents cd
      JOIN bank_transactions bt ON bt.id = cd.matched_bank_tx_id
     WHERE cd.id = ${documentId}::uuid AND cd.company_id = ${companyId}::uuid
       AND ${sql.unsafe(linkedCapturedDocSql('bt', 'cd'))}
  `) as Row[];
  return !!row;
}

export type UnlinkResult = 'unlinked' | 'not_linked';

/**
 * Detach a captured document from a bank line: clear the link and delete its copy on that line. The document row is
 * locked the way every posting path locks it (captureRowLock, 5 s, then CaptureRowLockTimeoutError: the route answers
 * 409), then its copies, as attaching takes them, so the two cannot deadlock.
 *
 * Status is NOT changed. 'matched' has several writers with nothing posted (the bank link, a duplicate supplier
 * invoice, a sent invoice, a dunning or outbound email) and the status before linking is not recorded, so no reset is
 * safe: setting a duplicate invoice back to 'pending' would make an invoice already booked postable again. The
 * document stays where document capture had it, and can be linked again from there.
 */
export async function unlinkCapturedDocFromBankTx(
  companyId: string, documentId: string, bankTxId: string,
): Promise<UnlinkResult> {
  if (!(await lockCapturedDocumentForUpdate(companyId, documentId))) return 'not_linked';
  // Read the link under the lock: an attach that moved the document to another line first is seen here.
  const [doc] = (await sql`
    SELECT id FROM captured_documents
     WHERE id = ${documentId}::uuid AND company_id = ${companyId}::uuid AND matched_bank_tx_id = ${bankTxId}::uuid
  `) as Row[];
  if (!doc) return 'not_linked';
  await sql`
    UPDATE captured_documents SET matched_bank_tx_id = NULL
     WHERE id = ${documentId}::uuid AND company_id = ${companyId}::uuid
  `;
  const removed = (await sql`
    DELETE FROM bank_transaction_attachments bta
     USING bank_transactions bt
     WHERE bta.bank_transaction_id = bt.id AND bt.id = ${bankTxId}::uuid AND bt.company_id = ${companyId}::uuid
       AND lower(left(bta.file_name, 37)) = ${String(doc.id)} || '_'
    RETURNING bta.id
  `) as Row[];
  log.info('Captured document unlinked from bank transaction', {
    companyId, documentId, bankTxId, copiesRemoved: removed.length,
  }, 'capture-attach');
  return 'unlinked';
}
