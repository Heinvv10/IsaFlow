/**
 * Workstream G — attach a captured document (slip photo) to a bank transaction.
 *
 * Links captured_documents.matched_bank_tx_id (existing match_bank_tx semantics)
 * AND mirrors the file bytes into bank_transaction_attachments (≤2 MB data-URL,
 * WS-D constraint) so the slip is visible in the bank-tx attachments modal.
 *
 * Tenant safety: both the document and the bank transaction are preflighted
 * against companyId before any write. The attachments table has no company_id —
 * scoping is via the verified bank_transaction_id (same as bankTxQueryReplyService).
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fetchRawBytes } from '@/lib/documentStorage';

const MAX_MIRROR_BYTES = 2 * 1024 * 1024;

const MIME_BY_FILE_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tiff: 'image/tiff',
};

export type AttachToBankTxResult =
  | { ok: true; mirrored: boolean }
  | { ok: false; reason: 'document_not_found' | 'bank_tx_not_found' };

type Row = Record<string, unknown>;

export async function attachCapturedDocToBankTx(
  companyId: string,
  documentId: string,
  bankTxId: string,
  userId: string | null,
): Promise<AttachToBankTxResult> {
  const [doc] = (await sql`
    SELECT id, file_name, file_type
      FROM captured_documents
     WHERE id = ${documentId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (!doc) return { ok: false, reason: 'document_not_found' };

  const [tx] = (await sql`
    SELECT id FROM bank_transactions
     WHERE id = ${bankTxId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (!tx) return { ok: false, reason: 'bank_tx_not_found' };

  await sql`
    UPDATE captured_documents
       SET status = 'matched',
           matched_bank_tx_id = ${bankTxId}::uuid
     WHERE id = ${documentId}::uuid AND company_id = ${companyId}::uuid
  `;

  const mirrored = await mirrorIntoAttachments(
    companyId, documentId, bankTxId, String(doc.file_name), String(doc.file_type), userId,
  );

  log.info('Captured document attached to bank transaction', {
    companyId, documentId, bankTxId, mirrored,
  }, 'capture-attach');

  return { ok: true, mirrored };
}

/** Mirror the file into bank_transaction_attachments. Never throws — link-only on failure. */
async function mirrorIntoAttachments(
  companyId: string,
  documentId: string,
  bankTxId: string,
  fileName: string,
  fileType: string,
  userId: string | null,
): Promise<boolean> {
  try {
    // Dedupe: same file on the same tx (retry / double-tap) — treat as already mirrored.
    const [dup] = (await sql`
      SELECT id FROM bank_transaction_attachments
       WHERE bank_transaction_id = ${bankTxId}::uuid AND file_name = ${fileName}
       LIMIT 1
    `) as Row[];
    if (dup) return true;

    const raw = await fetchRawBytes(documentId, companyId);
    if (!raw) {
      log.warn('capture-attach: raw bytes unavailable — linked without mirror', {
        companyId, documentId, bankTxId,
      }, 'capture-attach');
      return false;
    }
    if (raw.buffer.length > MAX_MIRROR_BYTES) {
      log.warn('capture-attach: file exceeds 2MB mirror cap — linked without mirror', {
        companyId, documentId, bankTxId, size: raw.buffer.length,
      }, 'capture-attach');
      return false;
    }

    const mime = MIME_BY_FILE_TYPE[fileType] ?? 'application/octet-stream';
    const dataUrl = `data:${mime};base64,${raw.buffer.toString('base64')}`;
    await sql`
      INSERT INTO bank_transaction_attachments
        (bank_transaction_id, file_url, file_name, file_size, uploaded_by)
      VALUES
        (${bankTxId}::uuid, ${dataUrl}, ${fileName}, ${raw.buffer.length}, ${userId})
    `;
    return true;
  } catch (err) {
    log.warn('capture-attach: mirror failed — linked without mirror', {
      companyId, documentId, bankTxId, error: err instanceof Error ? err.message : String(err),
    }, 'capture-attach');
    return false;
  }
}
