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
 *
 * A document over 2 MB, or one whose copy fails, stays linked without a copy: capturedAttachmentLinks lists and
 * counts it as an attachment of the line and serves its bytes, so it is not invisible.
 *
 * One tax invoice, one VAT claim (Hein, 2026-11-07): refused when the line's journal claims input VAT and the
 * document already backs a different VAT claim (bankAttachClaimConflict). Nothing is written then.
 *
 * Known debt: attachments carry no captured_document_id FK — provenance/dedupe rides on the filename prefix; a follow-up migration should add a nullable captured_document_id column.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fetchRawBytes } from '@/lib/documentStorage';
import { magicBytesMatchMime } from '@/lib/fileMagic';
import { mimeForCapturedFileType } from './capturedFileTypes';
import { findOtherVatClaim, type OtherVatClaim } from './bankAttachClaimConflict';

export { mimeForCapturedFileType };

const MAX_MIRROR_BYTES = 2 * 1024 * 1024;

export type AttachToBankTxResult =
  | { ok: true; mirrored: boolean }
  | { ok: false; reason: 'document_not_found' | 'bank_tx_not_found' }
  | { ok: false; reason: 'document_backs_other_claim'; otherClaim: OtherVatClaim };

type Row = Record<string, unknown>;

export async function attachCapturedDocToBankTx(
  companyId: string,
  documentId: string,
  bankTxId: string,
  userId: string | null,
): Promise<AttachToBankTxResult> {
  const [doc] = (await sql`
    SELECT id, file_name, file_type, matched_bank_tx_id
      FROM captured_documents
     WHERE id = ${documentId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (!doc) return { ok: false, reason: 'document_not_found' };

  const [tx] = (await sql`
    SELECT id FROM bank_transactions
     WHERE id = ${bankTxId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (!tx) return { ok: false, reason: 'bank_tx_not_found' };

  const otherClaim = await findOtherVatClaim(companyId, documentId, bankTxId);
  if (otherClaim) return { ok: false, reason: 'document_backs_other_claim', otherClaim };

  // Crash-recovery: UPDATE-then-mirror ordering means a crash between the two
  // heals on a retry — the re-UPDATE is idempotent and the dup-check misses,
  // so the mirror is attempted again.
  await sql`
    UPDATE captured_documents
       SET status = 'matched',
           matched_bank_tx_id = ${bankTxId}::uuid
     WHERE id = ${documentId}::uuid AND company_id = ${companyId}::uuid
  `;

  // The copy's name starts with the document's id as the database prints it (lower-case, hyphenated), never the
  // request's spelling: bank/bankLineDocumentSql recognises a copy by that prefix, and an upper-case or brace-wrapped
  // id would make the document count twice.
  // A relink moves the document: its copy on the line it leaves would otherwise keep supporting that line.
  const previous = doc.matched_bank_tx_id ? String(doc.matched_bank_tx_id) : null;
  if (previous && previous !== bankTxId) {
    await sql`
      DELETE FROM bank_transaction_attachments bta
       USING bank_transactions bt
       WHERE bta.bank_transaction_id = bt.id AND bt.id = ${previous}::uuid AND bt.company_id = ${companyId}::uuid
         AND lower(left(bta.file_name, 37)) = ${String(doc.id)} || '_'
    `;
  }

  const mirrored = await mirrorIntoAttachments(
    companyId, String(doc.id), bankTxId, String(doc.file_name), String(doc.file_type), userId,
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
    // Dedupe key is documentId-prefixed: a retry / double-tap of the SAME
    // document is treated as already mirrored, but two DIFFERENT documents
    // that happen to share a file name (e.g. image.jpg) both mirror.
    // TENANT-SAFETY: bank_transaction_attachments has no company_id; isolation rides on bankTxId being preflighted above — keep that ordering.
    const storedFileName = `${documentId}_${fileName}`;
    // Any copy of this document on this line, whatever case its id prefix was written in (bank/bankLineDocumentSql
    // recognises a copy case-insensitively, so an exact-name check here would insert a second one).
    const [dup] = (await sql`
      SELECT id FROM bank_transaction_attachments
       WHERE bank_transaction_id = ${bankTxId}::uuid AND lower(left(file_name, 37)) = ${documentId.toLowerCase()} || '_'
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

    // file_type can be whatever an email claimed, so a label only stands when the bytes agree with it. The upload route
    // refuses a mismatch; here the link is already made, so the file is kept under the type that makes no claim.
    const claimed = mimeForCapturedFileType(fileType);
    const mime = claimed && magicBytesMatchMime(raw.buffer, claimed) ? claimed : 'application/octet-stream';
    const dataUrl = `data:${mime};base64,${raw.buffer.toString('base64')}`;
    await sql`
      INSERT INTO bank_transaction_attachments
        (bank_transaction_id, file_url, file_name, file_size, uploaded_by)
      VALUES
        (${bankTxId}::uuid, ${dataUrl}, ${storedFileName}, ${raw.buffer.length}, ${userId})
    `;
    return true;
  } catch (err) {
    log.warn('capture-attach: mirror failed — linked without mirror', {
      companyId, documentId, bankTxId, error: err instanceof Error ? err.message : String(err),
    }, 'capture-attach');
    return false;
  }
}
