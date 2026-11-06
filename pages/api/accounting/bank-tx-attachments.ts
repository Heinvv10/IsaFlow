/**
 * Bank Transaction Attachments API
 *
 * GET  /api/accounting/bank-tx-attachments?bankTransactionId=<uuid>
 *   → List the line's supporting documents, newest first: uploads, and each linked captured document once
 *     (capture/capturedAttachmentLinks; document_id marks a linked one).
 *
 * POST /api/accounting/bank-tx-attachments
 *   Body: { bankTransactionId, fileName, fileData (base64 data URL), fileSize? }
 *   → Store an attachment. Small receipts (≤ 2 MB) are kept as data URLs in file_url.
 *
 * DELETE /api/accounting/bank-tx-attachments?id=<uuid>
 *   → Remove a single attachment record. 409 for the copy of a linked captured document (unlink it instead).
 * DELETE /api/accounting/bank-tx-attachments?documentId=<uuid>&bankTransactionId=<uuid>
 *   → Unlink a captured document from the line, deleting its copy there.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { magicBytesMatchMime, decodeUploadPayload } from '@/lib/fileMagic';
import { extractFromPdf, extractFromImage } from '@/modules/accounting/services/core/ocrService';
import { isVlmAvailable } from '@/modules/accounting/services/bank/vlmService';
import { runAfterCommit } from '@/lib/afterCommit';
import { listBankLineAttachments, unlinkCapturedDocFromBankTx } from '@/modules/accounting/services/capture/capturedAttachmentLinks';
import { isCopyOfSql, linkedCapturedDocSql } from '@/modules/accounting/services/bank/bankLineDocumentSql';
import { isValidUUID } from '@/lib/validation';

// ── Local Types ───────────────────────────────────────────────────────────────

// Neon's sql tagged template returns a union type. Casting through unknown[]
// is the project-standard pattern (see bankReconciliationService.ts Row = any).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqlRow = Record<string, any>;

const PostBodySchema = z.object({
  bankTransactionId: UUID,
  fileName: z.string().min(1).max(500),
  // base64 data URL — clamp at ~3 MB to give a margin over the 2 MB raw limit
  // (data URLs expand ~33%). The byte-size estimate below catches the real cap.
  fileData: z.string().min(20).max(3_500_000),
  fileSize: z.number().nonnegative().optional(),
}).strict();

// ── Constants ─────────────────────────────────────────────────────────────────

/** 2 MB limit — data URLs expand ~33 % in transit, so clamp at 2 MB of raw bytes */
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

/** Allowed attachment types — enforced against the decoded magic bytes (see POST). */
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the MIME type from a base64 data URL string */
function extractMime(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9.+-]+);base64,/);
  return match ? match[1] ?? null : null;
}

/** Rough byte size estimate for a base64-encoded data URL */
function estimateDataUrlBytes(dataUrl: string): number {
  const base64Part = dataUrl.split(',')[1] ?? '';
  return Math.ceil((base64Part.length * 3) / 4);
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId: string | null = req.user?.id ?? null;

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { bankTransactionId } = req.query;

    if (!bankTransactionId || typeof bankTransactionId !== 'string') {
      return apiResponse.badRequest(res, 'bankTransactionId query param is required');
    }

    // Verify the bank transaction belongs to this company
    const [btOwner] = await sql`
      SELECT id FROM bank_transactions WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
    ` as SqlRow[];
    if (!btOwner) return apiResponse.forbidden(res, 'Bank transaction does not belong to your company');

    // Uploads, and each linked captured document once (capture/capturedAttachmentLinks).
    const rows = await listBankLineAttachments(companyId, bankTransactionId);
    log.info('Listed bank tx attachments', { bankTransactionId, count: rows.length }, 'bank-tx-attachments');
    return apiResponse.success(res, rows);
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const parsed = PostBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    }
    const { bankTransactionId, fileName, fileData } = parsed.data;

    // Verify ownership before insert
    const [btCheck] = await sql`
      SELECT id FROM bank_transactions WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
    ` as SqlRow[];
    if (!btCheck) return apiResponse.forbidden(res, 'Bank transaction does not belong to your company');

    // Validate the claimed MIME (from the client-controlled data URL header).
    const mime = extractMime(fileData);
    if (!mime || !ALLOWED_MIME_TYPES.includes(mime)) {
      return apiResponse.badRequest(res, `File type not allowed. Accepted: ${ALLOWED_MIME_TYPES.join(', ')}`);
    }
    // H6: the header is spoofable, so confirm the DECODED bytes actually match the
    // claimed type (magic-byte sniffing). The old code only re-checked the header.
    const decoded = decodeUploadPayload(fileData);
    if (!decoded || !magicBytesMatchMime(decoded, mime)) {
      return apiResponse.badRequest(res, 'File contents do not match the declared type');
    }

    // Validate file size
    // Always compute from actual data — never trust client-supplied fileSize
    const byteSize = estimateDataUrlBytes(fileData);
    if (byteSize > MAX_FILE_SIZE_BYTES) {
      return apiResponse.badRequest(res, 'File exceeds the 2 MB size limit');
    }

    const insertRows = (await sql`
      INSERT INTO bank_transaction_attachments
        (bank_transaction_id, file_url, file_name, file_size, uploaded_by)
      VALUES
        (
          ${bankTransactionId}::UUID,
          ${fileData},
          ${fileName},
          ${byteSize},
          ${userId}::UUID
        )
      RETURNING
        id, bank_transaction_id, file_url, file_name, file_size, uploaded_by, created_at
    `) as SqlRow[];

    const attachment = insertRows[0];
    log.info('Uploaded bank tx attachment', { bankTransactionId, fileName, byteSize }, 'bank-tx-attachments');

    // Fire-and-forget VLM extraction on the attachment
    if (isVlmAvailable() && mime && attachment?.id) {
      runAfterCommit('bank tx attachment extraction', () => extractAttachmentData(fileData, mime, attachment.id as string, companyId).catch(err =>
        log.warn('Background attachment extraction failed', { error: err instanceof Error ? err.message : String(err) }, 'bank-tx-attachments')
      ));
    }

    return apiResponse.created(res, attachment, 'Attachment uploaded');
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id, documentId, bankTransactionId } = req.query;

    // Remove on a linked captured document unlinks it from the line, copy included (Hein, 2026-11-06).
    if (documentId !== undefined) {
      if (typeof documentId !== 'string' || !isValidUUID(documentId)
        || typeof bankTransactionId !== 'string' || !isValidUUID(bankTransactionId)) {
        return apiResponse.badRequest(res, 'documentId and bankTransactionId must be ids');
      }
      const outcome = await unlinkCapturedDocFromBankTx(companyId, documentId, bankTransactionId);
      if (outcome === 'not_linked') return apiResponse.notFound(res, 'Linked document', documentId);
      return apiResponse.success(res, { unlinked: documentId });
    }

    if (!id || typeof id !== 'string' || !isValidUUID(id)) {
      return apiResponse.badRequest(res, 'id query param must be an attachment id');
    }

    // Deleting only the copy of a linked captured document would bring the document back as uncopied on the next
    // read, so that copy is removed by unlinking the document.
    const [linkedCopy] = (await sql`
      SELECT cd.id FROM bank_transaction_attachments bta
        JOIN bank_transactions bt ON bt.id = bta.bank_transaction_id AND bt.company_id = ${companyId}
        JOIN captured_documents cd ON ${sql.unsafe(linkedCapturedDocSql('bt', 'cd'))} AND ${sql.unsafe(isCopyOfSql('bta', 'cd'))}
       WHERE bta.id = ${id}::UUID
    `) as SqlRow[];
    if (linkedCopy) {
      return apiResponse.conflict(res, 'This file is a captured document linked to the line. Remove it with documentId to unlink it.');
    }

    // Verify ownership via bank_transactions before delete
    const deleteRows = (await sql`
      DELETE FROM bank_transaction_attachments bta
      USING bank_transactions bt
      WHERE bta.id = ${id}::UUID
        AND bta.bank_transaction_id = bt.id
        AND bt.company_id = ${companyId}
      RETURNING bta.id
    `) as SqlRow[];

    if (!deleteRows || deleteRows.length === 0) {
      return apiResponse.notFound(res, 'Attachment', id);
    }

    log.info('Deleted bank tx attachment', { id }, 'bank-tx-attachments');
    return apiResponse.success(res, { deleted: id });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

/**
 * Background VLM extraction for bank tx attachments.
 *
 * Runs after the request COMMITs, on the pool's role with no RLS (R-075), so
 * the UPDATE carries the tenant predicate itself. bank_transaction_attachments
 * has no company_id column; it is scoped through its parent transaction, so
 * this reproduces the table's own RLS WITH CHECK.
 */
export async function extractAttachmentData(dataUrl: string, mime: string, attachmentId: string, companyId: string) {
  const base64Part = dataUrl.split(',')[1];
  if (!base64Part) return;

  const buffer = Buffer.from(base64Part, 'base64');
  const isPdf = mime === 'application/pdf';

  const extracted = isPdf
    ? await extractFromPdf(buffer)
    : await extractFromImage(buffer, mime);

  if (extracted && extracted.confidence > 0) {
    const stored = await sql`
      UPDATE bank_transaction_attachments
      SET extracted_data = ${JSON.stringify(extracted)}::jsonb
      WHERE id = ${attachmentId}::uuid
        AND EXISTS (
          SELECT 1 FROM bank_transactions bt
          WHERE bt.id = bank_transaction_attachments.bank_transaction_id
            AND bt.company_id = ${companyId}::uuid
        )
      RETURNING id
    `;
    // By outcome: the fence can match nothing, and a success log there would be
    // the same false "extraction complete" R-075 itself produced.
    if (stored.length === 0) {
      log.warn('VLM extraction discarded — attachment is not this company\'s', { attachmentId, companyId }, 'bank-tx-attachments');
    } else {
      log.info('VLM extraction stored for bank tx attachment', { attachmentId, confidence: extracted.confidence }, 'bank-tx-attachments');
    }
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
